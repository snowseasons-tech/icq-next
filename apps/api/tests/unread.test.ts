import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { io as connect, type Socket } from "socket.io-client";
import { buildApp } from "../src/app.js";

type Activity = { roomId: string; messageId: string; senderId: string };
type RoomRow = { id: string; kind: "GROUP" | "DIRECT"; unread: number };

function nextEvent<T>(socket: Socket, event: string, predicate: (value: T) => boolean, timeoutMs = 2000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

test("unread counts track messages from others, clear on read, and sync live", async () => {
  const app = await buildApp({ jwtSecret: "test-secret-at-least-32-characters" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const suffix = crypto.randomUUID().slice(0, 8);
  const sockets: Socket[] = [];

  async function signUp(name: string) {
    const username = `unr-${name}-${suffix}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, email: `${username}@example.com`, password: "strong-password" },
    });
    assert.equal(res.statusCode, 201);
    const { token, user } = res.json();
    return { token, id: user.sub as string, headers: { authorization: `Bearer ${token}` } };
  }

  async function socketFor(token: string) {
    const s = connect(url, { auth: { token }, transports: ["websocket"], forceNew: true });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once("connect", () => resolve());
      s.once("connect_error", reject);
    });
    // Round-trip so the socket's background join to its user/authenticated rooms has finished.
    await new Promise<void>((resolve) => s.emit("room:leave", "warmup", () => resolve()));
    return s;
  }

  async function roomsFor(headers: Record<string, string>) {
    const res = await app.inject({ method: "GET", url: "/api/rooms", headers });
    assert.equal(res.statusCode, 200);
    return res.json().rooms as RoomRow[];
  }

  const unreadIn = async (headers: Record<string, string>, roomId: string) =>
    (await roomsFor(headers)).find((r) => r.id === roomId)?.unread;

  try {
    const alice = await signUp("alice");
    const bob = await signUp("bob");
    const carol = await signUp("carol");
    const bobSocket = await socketFor(bob.token);
    const carolSocket = await socketFor(carol.token);
    const carolActivity: Activity[] = [];
    carolSocket.on("room:activity", (a: Activity) => carolActivity.push(a));

    const groupRes = await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: `Unread ${suffix}` } });
    const groupId = groupRes.json().room.id as string;

    // Group: Bob has two unread messages from Alice; Alice's own messages never count for her.
    await app.inject({ method: "POST", url: `/api/rooms/${groupId}/messages`, headers: alice.headers, payload: { content: "one" } });
    await app.inject({ method: "POST", url: `/api/rooms/${groupId}/messages`, headers: alice.headers, payload: { content: "two" } });
    assert.equal(await unreadIn(bob.headers, groupId), 2);
    assert.equal(await unreadIn(alice.headers, groupId), 0);

    // Opening the room clears it, and Bob's other sockets are told.
    const bobSyncs = nextEvent<{ roomId: string }>(bobSocket, "room:read", (e) => e.roomId === groupId);
    const read = await app.inject({ method: "POST", url: `/api/rooms/${groupId}/read`, headers: bob.headers });
    assert.equal(read.statusCode, 200);
    assert.equal((await bobSyncs).roomId, groupId);
    assert.equal(await unreadIn(bob.headers, groupId), 0);

    // A new message while Bob is away bumps his count live (he has not joined the room).
    const activity = nextEvent<Activity>(bobSocket, "room:activity", (a) => a.roomId === groupId);
    await app.inject({ method: "POST", url: `/api/rooms/${groupId}/messages`, headers: alice.headers, payload: { content: "three" } });
    assert.equal((await activity).senderId, alice.id);
    assert.equal(await unreadIn(bob.headers, groupId), 1);

    // Direct room: only the two members hear about it; Carol gets nothing.
    const dmRes = await app.inject({ method: "POST", url: "/api/direct-rooms", headers: alice.headers, payload: { userId: bob.id } });
    const dmId = dmRes.json().room.id as string;
    const dmActivity = nextEvent<Activity>(bobSocket, "room:activity", (a) => a.roomId === dmId);
    await app.inject({ method: "POST", url: `/api/rooms/${dmId}/messages`, headers: alice.headers, payload: { content: "dm hi" } });
    await dmActivity;
    assert.equal(await unreadIn(bob.headers, dmId), 1);
    assert.equal(await unreadIn(alice.headers, dmId), 0);
    assert.equal(await unreadIn(carol.headers, groupId), 3);
    // Carol's socket round-trip: any stray DM activity would have arrived before this returns.
    await new Promise<void>((resolve) => carolSocket.emit("room:leave", "warmup", () => resolve()));
    assert.ok(!carolActivity.some((a) => a.roomId === dmId));

    // Carol cannot mark a DM she is not in as read.
    assert.equal((await app.inject({ method: "POST", url: `/api/rooms/${dmId}/read`, headers: carol.headers })).statusCode, 404);
    // Bob reading the DM does not touch Alice's view of it.
    await app.inject({ method: "POST", url: `/api/rooms/${dmId}/read`, headers: bob.headers });
    assert.equal(await unreadIn(bob.headers, dmId), 0);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await app.close();
  }
});
