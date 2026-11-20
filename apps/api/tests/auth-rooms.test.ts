import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildApp } from "../src/app.js";

test("health, auth, rooms, and messages", async () => {
  const app = await buildApp({
    jwtSecret: "test-secret-at-least-32-characters",
  });
  const suffix = crypto.randomUUID();
  await app.ready();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 200);
    const unauth = await app.inject({ method: "GET", url: "/api/rooms" });
    assert.equal(unauth.statusCode, 401);

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: `alice-${suffix.slice(0, 8)}`, email: `alice-${suffix}@example.com`, password: "strong-password" },
    });
    assert.equal(registered.statusCode, 201);
    const token = registered.json().token;
    assert.ok(token);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.username, `alice-${suffix.slice(0, 8)}`);

    const room = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Test Room ${suffix.slice(0, 8)}` },
    });
    assert.equal(room.statusCode, 201);
    const roomId = room.json().room.id;

    const sent = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: "Hello migration tests" },
    });
    assert.equal(sent.statusCode, 201);

    const history = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().messages[0].content, "Hello migration tests");
  } finally {
    await app.close();
  }
});
