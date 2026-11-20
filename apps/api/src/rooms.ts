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
  return { id: room.id, name: room.name, kind: room.kind, createdAt: room.createdAt, peer };
}

export const roomSelect = {
  id: true,
  name: true,
  kind: true,
  createdAt: true,
  members: { select: { user: { select: { id: true, username: true } } } },
} as const;
