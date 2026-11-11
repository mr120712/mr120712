// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { loadMessageProfiles, serializeMessage } from '@/lib/business/messages.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  MessageMutationResponseSchema,
  MessageThreadResponseSchema,
  SendMessageSchema,
} from '@/lib/contracts/messages';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

async function authenticatedUser(request: Request): Promise<SessionUser | Response> {
  try {
    return await requireAuth(request);
  } catch (response) {
    return response as Response;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const user = await authenticatedUser(request);
  if (user instanceof Response) return user;
  const { conversationId } = await params;

  try {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ participantAId: user.id }, { participantBId: user.id }],
      },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!conversation)
      return NextResponse.json({ error: 'Conversazione non disponibile.' }, { status: 404 });

    const participantId =
      conversation.participantAId === user.id
        ? conversation.participantBId
        : conversation.participantAId;
    const people = await loadMessageProfiles([participantId]);
    const participant = people.get(participantId);
    if (!participant)
      return NextResponse.json({ error: 'Conversazione non disponibile.' }, { status: 404 });

    return NextResponse.json(
      MessageThreadResponseSchema.parse({
        currentUserId: user.id,
        conversation: { id: conversation.id, participant },
        messages: conversation.messages.map(serializeMessage),
      }),
    );
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile aprire la conversazione.' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'Origine della richiesta non valida.' }, { status: 403 });
  }

  const user = await authenticatedUser(request);
  if (user instanceof Response) return user;
  const body = await readJsonLimited(request, 24 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = SendMessageSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Inserisci un messaggio di testo valido.' }, { status: 400 });
  }
  const { conversationId } = await params;

  try {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ participantAId: user.id }, { participantBId: user.id }],
      },
      select: { id: true },
    });
    if (!conversation)
      return NextResponse.json({ error: 'Conversazione non disponibile.' }, { status: 404 });

    const limited = await enforceRateLimit('messages.send', `user:${user.id}`);
    if (limited) return limited;

    const result = await prisma.$transaction(async (transaction) => {
      const message = await transaction.message.create({
        data: { conversationId: conversation.id, senderId: user.id, content: parsed.data.content },
      });
      await transaction.conversation.updateMany({
        where: { id: conversation.id, lastMessageAt: { lt: message.createdAt } },
        data: { lastMessageAt: message.createdAt },
      });
      return message;
    });

    return NextResponse.json(
      MessageMutationResponseSchema.parse({
        conversationId: conversation.id,
        message: serializeMessage(result),
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
