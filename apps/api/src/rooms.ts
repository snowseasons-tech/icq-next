import type { PrismaClient } from "@prisma/client";

export type RoomKind = "GROUP" | "DIRECT";
export type UserRef = { id: string; username: string };
export type RoomSummary = {
  id: string;
  name: string;
  kind: RoomKind;
  createdAt: Date;
  // For direct rooms: the other person, from the viewer's point of view.
  peer: UserRef | null;
  // Messages from other people the viewer has not opened yet. Only set on the room list.
  unread: number;
};

type RoomWithMembers = {
  id: string;
  name: string;
  kind: RoomKind;
  createdAt: Date;
  members: { user: UserRef }[];
};

// GROUP rooms are open to every signed-in user; DIRECT rooms only to their members.
// Non-members get "not found" rather than "forbidden" so DM existence is not revealed.
export async function canAccessRoom(prisma: PrismaClient, roomId: string, userId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { kind: true, members: { where: { userId }, select: { userId: true }, take: 1 } },
  });
  if (!room) return false;
  return room.kind === "GROUP" || room.members.length > 0;
}

export function summarizeRoom(room: RoomWithMembers, viewerId: string): RoomSummary {
  const peer = room.kind === "DIRECT" ? room.members.map((m) => m.user).find((u) => u.id !== viewerId) ?? null : null;
  return { id: room.id, name: room.name, kind: room.kind, createdAt: room.createdAt, peer, unread: 0 };
}

// Counts messages from other users sent after the viewer's last read of each room.
export async function unreadCounts(prisma: PrismaClient, userId: string, roomIds: string[]): Promise<Map<string, number>> {
  const reads = await prisma.roomRead.findMany({
    where: { userId, roomId: { in: roomIds } },
    select: { roomId: true, lastReadAt: true },
  });
  const lastRead = new Map(reads.map((read) => [read.roomId, read.lastReadAt]));
  const counts = await Promise.all(roomIds.map((roomId) =>
    prisma.message.count({
      where: { roomId, senderId: { not: userId }, createdAt: { gt: lastRead.get(roomId) ?? new Date(0) } },
    }).then((count) => [roomId, count] as const),
  ));
  return new Map(counts);
}

export const roomSelect = {
  id: true,
  name: true,
  kind: true,
  createdAt: true,
  members: { select: { user: { select: { id: true, username: true } } } },
} as const;
