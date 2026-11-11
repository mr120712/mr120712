// @polsia:user-owned
//
// Payment fulfillment via Polsia's payment-events feed (no inbound Stripe
// callbacks): pull events from a cursor, process each idempotently.
//
// Wire the cursor to durable storage (a one-row Prisma model works):
//
//   model StripeBillingCursor {
//     id     Int @id @default(1)
//     cursor Int @default(0)
//   }
//
// Call processNewPaymentEvents where fulfillment happens: a verified success
// page, an admin refresh, or a polsia.toml cron (AGENT.md has the recipe).

import 'server-only';
import { listPaymentEvents } from '@/lib/stripe-billing/client';
import type { PaymentEvent } from '@/lib/stripe-billing/schema';

export interface ProcessPaymentEventsOptions {
  /** Last processed event id. Load it from durable storage. */
  sinceCursor: number;
  /**
   * Handle ONE event (mark an order paid, grant access, send a receipt, ...).
   * Filter on event.type — buyer payments arrive as 'payment_received'.
   * MUST be idempotent: dedupe on event.id or event.stripeCheckoutSessionId —
   * the same event can be delivered again after a partial failure.
   */
  onEvent: (event: PaymentEvent) => Promise<void>;
  /** Safety bound per invocation. Default 10 pages of 100 events. */
  maxPages?: number;
}

export interface ProcessPaymentEventsResult {
  /** Persist this back to durable storage for the next invocation. */
  nextCursor: number;
  processed: number;
  /**
   * Set when the handler threw. nextCursor points at the last SUCCESSFUL
   * event, so persisting it makes the failed event redeliver next invocation.
   */
  failed?: { eventId: number; message: string };
}

export async function processNewPaymentEvents(
  options: ProcessPaymentEventsOptions,
): Promise<ProcessPaymentEventsResult> {
  const maxPages = options.maxPages ?? 10;
  let cursor = options.sinceCursor;
  let processed = 0;

  for (let page = 0; page < maxPages; page++) {
    const { events, nextCursor } = await listPaymentEvents({
      sinceCursor: cursor,
      limit: 100,
    });
    if (events.length === 0) break;

    for (const event of events) {
      try {
        await options.onEvent(event);
      } catch (err) {
        // Stop and report progress instead of throwing: the caller persists
        // nextCursor (last successful event) and the failed event redelivers.
        return {
          nextCursor: cursor,
          processed,
          failed: {
            eventId: event.id,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
      cursor = event.id;
      processed += 1;
    }
    cursor = nextCursor;
  }

  return { nextCursor: cursor, processed };
}
