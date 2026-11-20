import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { io as connect, type Socket } from "socket.io-client";
import { buildApp } from "../src/app.js";

type Summary = { id: string; name: string; kind: "GROUP" | "DIRECT"; peer: { id: string; username: string } | null };

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

function emitWithAck(socket: Socket, event: string, payload: unknown) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000);
    socket.emit(event, payload, (response: any) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

test("direct rooms are private to their two members and open on demand", async () => {
  const app = await buildApp({ jwtSecret: "test-secret-at-least-32-characters" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const suffix = crypto.randomUUID().slice(0, 8);
  const sockets: Socket[] = [];

  async function signUp(name: string) {
    const username = `dm-${name}-${suffix}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, email: `${username}@example.com`, password: "strong-password" },
    });
    assert.equal(res.statusCode, 201);
    const { token, user } = res.json();
    return { token, id: user.sub as string, username, headers: { authorization: `Bearer ${token}` } };
  }

  try {
    const alice = await signUp("alice");
    const bob = await signUp("bob");
    const carol = await signUp("carol");

    // Carol's socket watches for announcements; Bob's watches for his own DMs.
    const carolSocket = connect(url, { auth: { token: carol.token }, transports: ["websocket"], forceNew: true });
    const bobSocket = connect(url, { auth: { token: bob.token }, transports: ["websocket"], forceNew: true });
    sockets.push(carolSocket, bobSocket);
    await Promise.all([carolSocket, bobSocket].map((s) => new Promise<void>((resolve, reject) => {
      s.once("connect", () => resolve());
      s.once("connect_error", reject);
    })));

    // Round-trip through a handler so each socket's background join is finished before we act.
    const groupName = `Group ${suffix}`;
    const groupRes = nextEvent<Summary>(carolSocket, "room:new", (r) => r.name === groupName);
    const group = await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: groupName } });
    assert.equal(group.statusCode, 201);
    assert.equal((await groupRes).kind, "GROUP");
    const groupId = group.json().room.id as string;
    assert.equal((await emitWithAck(bobSocket, "room:join", groupId)).ok, true);

    // Validation.
    const self = await app.inject({ method: "POST", url: "/api/direct-rooms", headers: alice.headers, payload: { userId: alice.id } });
    assert.equal(self.statusCode, 400);
    const missing = await app.inject({ method: "POST", url: "/api/direct-rooms", headers: alice.headers, payload: { userId: "does-not-exist" } });
    assert.equal(missing.statusCode, 404);

    // Alice opens a DM with Bob; Bob is told about it live.
    const bobSees = nextEvent<Summary>(bobSocket, "room:new", (r) => r.kind === "DIRECT");
    const opened = await app.inject({ method: "POST", url: "/api/direct-rooms", headers: alice.headers, payload: { userId: bob.id } });
    assert.equal(opened.statusCode, 201);
    const dmId = opened.json().room.id as string;
    assert.equal(opened.json().room.peer.username, bob.username);
    assert.equal((await bobSees).id, dmId);

    // Opening it again (from either side) returns the same room.
    const again = await app.inject({ method: "POST", url: "/api/direct-rooms", headers: bob.headers, payload: { userId: alice.id } });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().room.id, dmId);
    assert.equal(again.json().room.peer.username, alice.username);

    // Listing: members see the DM, outsiders do not.
    const bobRooms = (await app.inject({ method: "GET", url: "/api/rooms", headers: bob.headers })).json().rooms as Summary[];
    assert.ok(bobRooms.some((r) => r.id === dmId));
    const carolRooms = (await app.inject({ method: "GET", url: "/api/rooms", headers: carol.headers })).json().rooms as Summary[];
    assert.ok(!carolRooms.some((r) => r.id === dmId));
    assert.ok(carolRooms.some((r) => r.id === groupId));

    // Outsiders get "not found", not "forbidden", for the DM's messages and sends.
    assert.equal((await app.inject({ method: "GET", url: `/api/rooms/${dmId}/messages`, headers: carol.headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/rooms/${dmId}/messages`, headers: carol.headers, payload: { content: "sneaky" } })).statusCode, 404);
    assert.equal((await emitWithAck(carolSocket, "room:join", dmId)).ok, false);

    // Members can talk; Bob's live socket receives Alice's message.
    assert.equal((await emitWithAck(bobSocket, "room:join", dmId)).ok, true);
    const bobGetsLive = nextEvent<{ content: string; roomId: string }>(bobSocket, "message:new", (m) => m.content === "hi bob");
    const sent = await app.inject({ method: "POST", url: `/api/rooms/${dmId}/messages`, headers: alice.headers, payload: { content: "hi bob" } });
    assert.equal(sent.statusCode, 201);
    assert.equal((await bobGetsLive).roomId, dmId);
    const history = (await app.inject({ method: "GET", url: `/api/rooms/${dmId}/messages`, headers: bob.headers })).json().messages;
    assert.deepEqual(history.map((m: { content: string }) => m.content), ["hi bob"]);

    // Carol never sees the DM's traffic on her socket (she is not joined to it).
    const carolLeaks: string[] = [];
    carolSocket.on("message:new", (m: { content: string }) => carolLeaks.push(m.content));
    await app.inject({ method: "POST", url: `/api/rooms/${dmId}/messages`, headers: bob.headers, payload: { content: "private again" } });
    await emitWithAck(carolSocket, "room:join", groupId); // round-trip so any leak would have arrived
    assert.deepEqual(carolLeaks, []);

    // User search: prefix match, excludes the caller.
    const search = await app.inject({ method: "GET", url: `/api/users?q=${encodeURIComponent(`dm-bob-${suffix}`.slice(0, 12))}`, headers: alice.headers });
    assert.equal(search.statusCode, 200);
    const found = search.json().users as { id: string }[];
    assert.ok(found.some((u) => u.id === bob.id));
    assert.ok(!found.some((u) => u.id === alice.id));
  } finally {
    for (const socket of sockets) socket.disconnect();
    await app.close();
  }
});
