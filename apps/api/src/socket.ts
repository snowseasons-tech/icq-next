import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { PrismaClient } from "@prisma/client";
import { canAccessRoom } from "./rooms.js";

type JwtVerifier = (token: string) => Promise<{ sub: string; username: string; email: string }>;
type Ack = (response: { ok: boolean; error?: string }) => void;

// Socket.io rooms used for server-pushed events:
//   "authenticated"  every verified socket (new group rooms are announced here)
//   "user:<id>"      one user's sockets (new direct rooms are announced here)
export const AUTHENTICATED_ROOM = "authenticated";
export const userRoom = (userId: string) => `user:${userId}`;

// Tells clients a message arrived, even when they have not joined that room (for unread counts).
// Group activity goes to every authenticated socket; direct activity only to the two members.
export async function announceMessage(
    io: SocketServer,
    prisma: PrismaClient,
    message: { id: string; roomId: string; senderId: string; createdAt: Date },
) {
    const room = await prisma.room.findUnique({
        where: { id: message.roomId },
        select: { kind: true, members: { select: { userId: true } } },
    });
    if (!room) return;
    const payload = { roomId: message.roomId, messageId: message.id, senderId: message.senderId, createdAt: message.createdAt };
    if (room.kind === "GROUP") {
        io.to(AUTHENTICATED_ROOM).emit("room:activity", payload);
    } else {
        for (const member of room.members) io.to(userRoom(member.userId)).emit("room:activity", payload);
    }
}

export const configureSocket = (
    httpServer: HttpServer,
    prisma: PrismaClient,
    verifyToken: JwtVerifier,
) => {
    const io = new SocketServer(httpServer, {
        cors: {
            origin: "*",
        }
    });

    io.on("connection", (socket) => {
        const token = socket.handshake.auth?.token;

        if (typeof token === "string") {
            verifyToken(token)
                .then((user) => {
                    socket.join(AUTHENTICATED_ROOM);
                    socket.join(userRoom(user.sub));
                })
                .catch(() => socket.emit("socket:error", { error: "Invalid session" }));
        }

        socket.on("room:join", async (roomId: unknown, ack?: Ack) => {
            if (typeof token !== "string") return socket.emit("socket:error", { error: "Authentication required" });
            try {
                const user = await verifyToken(token);
                const id = String(roomId || "");
                if (!id || !(await canAccessRoom(prisma, id, user.sub))) {
                    socket.emit("socket:error", { error: "Room not found" });
                    return ack?.({ ok: false, error: "Room not found" });
                }
                await socket.join(id);
                ack?.({ ok: true });
            } catch {
                socket.emit("socket:error", { error: "Invalid session" });
                ack?.({ ok: false, error: "Invalid session" });
            }
        });

        socket.on("room:leave", (roomId: unknown, ack?: Ack) => {
            if (typeof roomId === "string" && roomId) void socket.leave(roomId);
            ack?.({ ok: true });
        });

        socket.on("message:send", async (payload: { roomId?: string; content?: string }) => {
            if (typeof token !== "string") return socket.emit("socket:error", { error: "Authentication required" });
            try {
                const payloadUser = await verifyToken(token);
                const roomId = String(payload.roomId || "");
                const content = String(payload.content || "").trim();
                if (!roomId || !content || content.length > 2000) {
                    return socket.emit("socket:error", { error: "Invalid message" });
                }
                if (!(await canAccessRoom(prisma, roomId, payloadUser.sub))) {
                    return socket.emit("socket:error", { error: "Room not found" });
                }
                const message = await prisma.message.create({
                    data: { content, roomId, senderId: payloadUser.sub },
                    include: { sender: { select: { id: true, username: true } } },
                });
                io.to(roomId).emit("message:new", message);
                await announceMessage(io, prisma, message);
            } catch {
                socket.emit("socket:error", { error: "Could not send message" });
            }
        });
    });

    return io;
};
