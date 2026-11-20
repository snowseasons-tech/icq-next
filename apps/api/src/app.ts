import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import prismaPackage from "@prisma/client";
import { z } from "zod";
import type { PrismaClient as PrismaClientType } from "@prisma/client";
import type { Server as SocketServer } from "socket.io";
import { AUTHENTICATED_ROOM, announceMessage, configureSocket, userRoom } from "./socket.js";
import { canAccessRoom, roomSelect, summarizeRoom, unreadCounts } from "./rooms.js";

type BuildOptions = { jwtSecret?: string; prisma?: PrismaClientType };
const { PrismaClient } = prismaPackage as typeof import("@prisma/client");
export type JwtPayload = { sub: string; username: string; email: string };

declare module "fastify" {
  interface FastifyInstance {
    io: SocketServer;
  }
}

export async function buildApp(options: BuildOptions = {}) {
  const app = Fastify();
  const prisma = options.prisma || new PrismaClient();
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || "development-only-secret-change-me";

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: jwtSecret });

  // Socket.io shares the HTTP server, so REST-created messages can reach live clients too.
  const io = configureSocket(app.server, prisma, async (token) => app.jwt.verify<JwtPayload>(token));
  app.decorate("io", io);

  async function authorize(request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Authentication required" });
    }
  }

  app.get("/", async () => ({ status: "ok" }));

  app.post("/api/auth/register", async (request, reply) => {
    const parsed = z.object({
      username: z.string().trim().min(3).max(30).optional(),
      email: z.string().trim().email().max(254),
      password: z.string().min(8).max(128),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message || "Invalid registration data" });
    const body = parsed.data;
    const username = body.username || body.email.split("@")[0];
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return reply.code(400).send({ error: "Invalid username" });
    const existing = await prisma.user.findFirst({ where: { OR: [{ email: body.email.toLowerCase() }, { username }] } });
    if (existing) return reply.code(409).send({ error: "Email or username is already in use" });
    const user = await prisma.user.create({ data: { username, email: body.email.toLowerCase(), password: await bcrypt.hash(body.password, 12) } });
    const payload: JwtPayload = { sub: user.id, username: user.username, email: user.email };
    return reply.code(201).send({ token: app.jwt.sign(payload, { expiresIn: "7d" }), user: payload });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Email and password are required" });
    const body = parsed.data;
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(body.password, user.password))) return reply.code(401).send({ error: "Incorrect email or password" });
    const payload: JwtPayload = { sub: user.id, username: user.username, email: user.email };
    return { token: app.jwt.sign(payload, { expiresIn: "7d" }), user: payload };
  });

  app.get("/api/me", { onRequest: [authorize] }, async (request: any, reply) => {
    const payload = request.user as JwtPayload;
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, username: true, email: true, createdAt: true } });
    if (!user) return reply.code(404).send({ error: "Account not found" });
    return { user };
  });

  app.get("/api/rooms", { onRequest: [authorize] }, async (request: any) => {
    const { sub } = request.user as JwtPayload;
    const rooms = await prisma.room.findMany({
      where: { OR: [{ kind: "GROUP" }, { members: { some: { userId: sub } } }] },
      orderBy: { createdAt: "asc" },
      select: roomSelect,
    });
    const unread = await unreadCounts(prisma, sub, rooms.map((room) => room.id));
    return { rooms: rooms.map((room) => ({ ...summarizeRoom(room, sub), unread: unread.get(room.id) ?? 0 })) };
  });

  app.post("/api/rooms", { onRequest: [authorize] }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(50) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Room name must be 2–50 characters" });
    const existing = await prisma.room.findFirst({ where: { name: parsed.data.name, kind: "GROUP" } });
    if (existing) return reply.code(409).send({ error: "A room with that name already exists" });
    const room = await prisma.room.create({ data: { name: parsed.data.name }, select: roomSelect });
    const summary = summarizeRoom(room, (request.user as JwtPayload).sub);
    app.io.to(AUTHENTICATED_ROOM).emit("room:new", summary);
    return reply.code(201).send({ room: summary });
  });

  // Find people to message. Usernames are visible to every signed-in user, as with group rooms.
  app.get("/api/users", { onRequest: [authorize] }, async (request: any) => {
    const { sub } = request.user as JwtPayload;
    const q = z.string().max(30).catch("").parse(request.query?.q ?? "").trim();
    const users = await prisma.user.findMany({
      where: { id: { not: sub }, username: { startsWith: q, mode: "insensitive" } },
      orderBy: { username: "asc" },
      take: 20,
      select: { id: true, username: true },
    });
    return { users };
  });

  // Opens the direct room between the caller and another user, creating it on first use.
  app.post("/api/direct-rooms", { onRequest: [authorize] }, async (request, reply) => {
    const parsed = z.object({ userId: z.string().min(1).max(64) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "userId is required" });
    const me = (request.user as JwtPayload).sub;
    const peerId = parsed.data.userId;
    if (peerId === me) return reply.code(400).send({ error: "You cannot start a direct message with yourself" });
    const peer = await prisma.user.findUnique({ where: { id: peerId }, select: { id: true, username: true } });
    if (!peer) return reply.code(404).send({ error: "User not found" });

    const [a, b] = [me, peerId].sort();
    const dmKey = `${a}:${b}`;
    const existing = await prisma.room.findUnique({ where: { dmKey }, select: roomSelect });
    if (existing) return { room: summarizeRoom(existing, me) };

    const meUser = await prisma.user.findUniqueOrThrow({ where: { id: me }, select: { username: true } });
    let created;
    try {
      created = await prisma.room.create({
        data: {
          name: [meUser.username, peer.username].sort().join(" & "),
          kind: "DIRECT",
          dmKey,
          members: { create: [{ userId: me }, { userId: peerId }] },
        },
        select: roomSelect,
      });
    } catch (error: any) {
      // Two requests raced to open the same DM; the loser returns the room the winner created.
      if (error?.code !== "P2002") throw error;
      const raced = await prisma.room.findUniqueOrThrow({ where: { dmKey }, select: roomSelect });
      return { room: summarizeRoom(raced, me) };
    }
    for (const userId of [me, peerId]) {
      app.io.to(userRoom(userId)).emit("room:new", summarizeRoom(created, userId));
    }
    return reply.code(201).send({ room: summarizeRoom(created, me) });
  });

  app.get("/api/rooms/:roomId/messages", { onRequest: [authorize] }, async (request: any, reply) => {
    const { roomId } = request.params as { roomId: string };
    const { sub } = request.user as JwtPayload;
    if (!(await canAccessRoom(prisma, roomId, sub))) return reply.code(404).send({ error: "Room not found" });
    const messages = await prisma.message.findMany({ where: { roomId }, orderBy: { createdAt: "asc" }, take: 100, include: { sender: { select: { id: true, username: true } } } });
    return { messages };
  });

  app.post("/api/rooms/:roomId/messages", { onRequest: [authorize] }, async (request: any, reply) => {
    const { roomId } = request.params as { roomId: string };
    const parsed = z.object({ content: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Message must be 1–2000 characters" });
    const payload = request.user as JwtPayload;
    if (!(await canAccessRoom(prisma, roomId, payload.sub))) return reply.code(404).send({ error: "Room not found" });
    const message = await prisma.message.create({ data: { content: parsed.data.content, roomId, senderId: payload.sub }, include: { sender: { select: { id: true, username: true } } } });
    app.io.to(roomId).emit("message:new", message);
    await announceMessage(app.io, prisma, message);
    return reply.code(201).send({ message });
  });

  // Marks a room read for the caller. Other tabs of the same user are told so their badges clear too.
  app.post("/api/rooms/:roomId/read", { onRequest: [authorize] }, async (request: any, reply) => {
    const { roomId } = request.params as { roomId: string };
    const { sub } = request.user as JwtPayload;
    if (!(await canAccessRoom(prisma, roomId, sub))) return reply.code(404).send({ error: "Room not found" });
    const lastReadAt = new Date();
    await prisma.roomRead.upsert({
      where: { userId_roomId: { userId: sub, roomId } },
      create: { userId: sub, roomId, lastReadAt },
      update: { lastReadAt },
    });
    app.io.to(userRoom(sub)).emit("room:read", { roomId, lastReadAt });
    return { roomId, lastReadAt };
  });

  app.addHook("onClose", async () => {
    io.disconnectSockets(true);
    io.engine.close();
    if (!options.prisma) await prisma.$disconnect();
  });

  return app;
}
