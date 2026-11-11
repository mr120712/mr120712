// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
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

// A thread opens on its most recent messages; older ones are read with ?before=<message id>.
const THREAD_PAGE_SIZE = 200;
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const BeforeCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const MessageThreadPageSchema = MessageThreadResponseSchema.extend({
  hasMore: z.boolean(),
  nextBefore: z.string().min(1).nullable(),
});

function participantFilter(userId: string) {
  return [{ participantAId: userId }, { participantBId: userId }];
}

function chronological(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
) {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

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

  const before = new URL(request.url).searchParams.get('before');
  if (before !== null && !BeforeCursorSchema.safeParse(before).success) {
    return NextResponse.json(
      { error: 'Il punto di partenza dei messaggi non è valido.' },
      { status: 400, headers: privateHeaders },
    );
  }

  try {
    // The cursor must be a message of this conversation, visible to this participant.
    const cursor =
      before === null
        ? null
        : await prisma.message.findFirst({
            where: {
              id: before,
              conversation: { id: conversationId, OR: participantFilter(user.id) },
            },
            select: { id: true, createdAt: true },
          });
    if (before !== null && !cursor) {
      return NextResponse.json(
        { error: 'Il punto di partenza dei messaggi non è valido.' },
        { status: 400, headers: privateHeaders },
      );
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: participantFilter(user.id),
      },
      include: {
        messages: {
          where: cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : undefined,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: THREAD_PAGE_SIZE + 1,
        },
      },
    });
    if (!conversation)
      return NextResponse.json(
        { error: 'Conversazione non disponibile.' },
        { status: 404, headers: privateHeaders },
      );

    const participantId =
      conversation.participantAId === user.id
        ? conversation.participantBId
        : conversation.participantAId;
    const people = await loadMessageProfiles([participantId]);
    const participant = people.get(participantId);
    if (!participant)
      return NextResponse.json(
        { error: 'Conversazione non disponibile.' },
        { status: 404, headers: privateHeaders },
      );

    // Newest page first from the database, shown oldest to newest; the extra row signals more.
    const ordered = [...conversation.messages].sort(chronological);
    const hasMore = ordered.length > THREAD_PAGE_SIZE;
    const page = hasMore ? ordered.slice(ordered.length - THREAD_PAGE_SIZE) : ordered;

    return NextResponse.json(
      MessageThreadPageSchema.parse({
        currentUserId: user.id,
        conversation: { id: conversation.id, participant },
        messages: page.map(serializeMessage),
        hasMore,
        nextBefore: hasMore ? (page[0]?.id ?? null) : null,
      }),
      { headers: privateHeaders },
    );
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile aprire la conversazione.' },
      { status: 500, headers: privateHeaders },
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
