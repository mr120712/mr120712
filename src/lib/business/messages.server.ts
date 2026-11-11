// @polsia:user-owned
import 'server-only';
import type { Message } from '@prisma/client';
import type { MessageProfile } from '@/lib/contracts/messages';
import { prisma } from '@/lib/db';

export function orderedParticipantIds(firstId: string, secondId: string) {
  return firstId < secondId
    ? { participantAId: firstId, participantBId: secondId }
    : { participantAId: secondId, participantBId: firstId };
}

export async function loadMessageProfiles(userIds: string[]) {
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return new Map<string, MessageProfile>();

  const [users, profiles] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: uniqueIds } }, select: { id: true, name: true } }),
    prisma.userProfile.findMany({
      where: { userId: { in: uniqueIds } },
      select: { userId: true, profileRole: true },
    }),
  ]);
  const roles = new Map(profiles.map((profile) => [profile.userId, profile.profileRole]));
  return new Map(
    users.map((user) => [
      user.id,
      {
        id: user.id,
        name: user.name.trim() || 'Profilo Solco',
        role: roles.get(user.id) === 'artist' ? 'artist' : 'fan',
      },
    ]),
  );
}

export function serializeMessage(
  message: Pick<Message, 'id' | 'senderId' | 'content' | 'createdAt'>,
) {
  return {
    id: message.id,
    senderId: message.senderId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}
