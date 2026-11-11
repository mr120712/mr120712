// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  loadMessageProfiles,
  orderedParticipantIds,
  serializeMessage,
} from '@/lib/business/messages.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  CreateConversationMessageSchema,
  MessageMutationResponseSchema,
  MessagesInboxResponseSchema,
} from '@/lib/contracts/messages';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

async function authenticatedUser(request: Request): Promise<SessionUser | Response> {
  try {
    return await requireAuth(request);
  } catch (response) {
    return response as Response;
  }
}

export async function GET(request: Request) {
  const user = await authenticatedUser(request);
  if (user instanceof Response) return user;

  try {
    const conversations = await prisma.conversation.findMany({
      where: { OR: [{ participantAId: user.id }, { participantBId: user.id }] },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }],
      include: { messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
    });
    const people = await loadMessageProfiles(
      conversations.map((conversation) =>
        conversation.participantAId === user.id
          ? conversation.participantBId
          : conversation.participantAId,
      ),
    );
    const items = conversations.flatMap((conversation) => {
      const participantId =
        conversation.participantAId === user.id
          ? conversation.participantBId
          : conversation.participantAId;
      const participant = people.get(participantId);
      const latestMessage = conversation.messages[0];
      if (!participant || !latestMessage) return [];
      return [
        {
          id: conversation.id,
          participant,
          lastMessage: {
            content: latestMessage.content,
            createdAt: latestMessage.createdAt.toISOString(),
          },
        },
      ];
    });

    return NextResponse.json(MessagesInboxResponseSchema.parse({ conversations: items }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile caricare i messaggi.' },
      { status: 500, headers: privateHeaders },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'Origine della richiesta non valida.' }, { status: 403 });
  }

  const user = await authenticatedUser(request);
  if (user instanceof Response) return user;

  const body = await readJsonLimited(request, 24 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = CreateConversationMessageSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Inserisci un messaggio di testo valido.' }, { status: 400 });
  }

  try {
    const targetProfile = await prisma.userProfile.findUnique({
      where: { id: parsed.data.profileId },
    });
    if (
      !targetProfile ||
      targetProfile.profileVisibility !== 'public' ||
      targetProfile.userId === user.id
    ) {
      return NextResponse.json({ error: 'Il profilo non è disponibile.' }, { status: 404 });
    }
    const recipient = await prisma.user.findUnique({
      where: { id: targetProfile.userId },
      select: { id: true },
    });
    if (!recipient)
      return NextResponse.json({ error: 'Il profilo non è disponibile.' }, { status: 404 });

    const limited = await enforceRateLimit('messages.send', `user:${user.id}`);
    if (limited) return limited;

    const participants = orderedParticipantIds(user.id, recipient.id);
    const createdAt = new Date();
    const result = await prisma.$transaction(async (transaction) => {
      const conversation = await transaction.conversation.upsert({
        where: { participantAId_participantBId: participants },
        create: { ...participants, lastMessageAt: createdAt },
        update: {},
      });
      const message = await transaction.message.create({
        data: {
          conversationId: conversation.id,
          senderId: user.id,
          content: parsed.data.content,
          createdAt,
        },
      });
      await transaction.conversation.updateMany({
        where: { id: conversation.id, lastMessageAt: { lt: createdAt } },
        data: { lastMessageAt: createdAt },
      });
      return { conversationId: conversation.id, message };
    });

    return NextResponse.json(
      MessageMutationResponseSchema.parse({
        conversationId: result.conversationId,
        message: serializeMessage(result.message),
      }),
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile inviare il messaggio.' },
      { status: 500 },
    );
  }
}
