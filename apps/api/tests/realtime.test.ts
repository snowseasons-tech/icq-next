import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { io as connect, type Socket } from "socket.io-client";
import { buildApp } from "../src/app.js";

type ChatMessage = { id: string; content: string; roomId: string };

function waitForMessage(socket: Socket, predicate: (m: ChatMessage) => boolean, timeoutMs = 2000) {
  return new Promise<ChatMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message:new")), timeoutMs);
    const handler = (m: ChatMessage) => {
      if (!predicate(m)) return;
      clearTimeout(timer);
      socket.off("message:new", handler);
      resolve(m);
    };
    socket.on("message:new", handler);
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

test("live messages are scoped to joined rooms and REST sends are broadcast", async () => {
  const app = await buildApp({ jwtSecret: "test-secret-at-least-32-characters" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;
  const suffix = crypto.randomUUID().slice(0, 8);
  const sockets: Socket[] = [];
  try {
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: `rt-${suffix}`, email: `rt-${suffix}@example.com`, password: "strong-password" },
    });
    const token = registered.json().token as string;
    const auth = { authorization: `Bearer ${token}` };

    const roomA = (await app.inject({ method: "POST", url: "/api/rooms", headers: auth, payload: { name: `A ${suffix}` } })).json().room.id as string;
    const roomB = (await app.inject({ method: "POST", url: "/api/rooms", headers: auth, payload: { name: `B ${suffix}` } })).json().room.id as string;

    const client = connect(url, { auth: { token }, transports: ["websocket"], forceNew: true });
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("connect_error", reject);
    });

    assert.equal((await emitWithAck(client, "room:join", roomA)).ok, true);

    // A REST send (the client's fallback path) must reach a socket in that room.
    const receivedPromise = waitForMessage(client, (m) => m.content === "via rest A");
    const restA = await app.inject({ method: "POST", url: `/api/rooms/${roomA}/messages`, headers: auth, payload: { content: "via rest A" } });
    assert.equal(restA.statusCode, 201);
    const received = await receivedPromise;
    assert.equal(received.roomId, roomA);

    // Switching rooms: leave A, join B. A's traffic must stop, B's must arrive.
    assert.equal((await emitWithAck(client, "room:leave", roomA)).ok, true);
    assert.equal((await emitWithAck(client, "room:join", roomB)).ok, true);

    const seen: ChatMessage[] = [];
    client.on("message:new", (m: ChatMessage) => seen.push(m));

    await app.inject({ method: "POST", url: `/api/rooms/${roomA}/messages`, headers: auth, payload: { content: "stale A" } });
    // Listen before sending: the socket can deliver before the HTTP response returns.
    const freshB = waitForMessage(client, (m) => m.content === "fresh B");
    await app.inject({ method: "POST", url: `/api/rooms/${roomB}/messages`, headers: auth, payload: { content: "fresh B" } });
    await freshB;

    assert.deepEqual(seen.map((m) => m.content), ["fresh B"]);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await app.close();
  }
});
