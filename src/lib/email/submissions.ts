// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/email@0.5.0. Drift = commit rejected.
//
// Server-only FORM-SUBMISSION intake — POSTs to the Polsia submissions proxy so a contact-form or
// waitlist entry lands in the founder's Polsia dashboard as a message FROM THE VISITOR. That
// direction is the whole point: a submission recorded this way shows up in the dashboard's
// submission views AND its reply button reaches the person who filled the form. Emailing the
// company's own inbox instead (the pre-0.5.0 behaviour) produces a message from the company to
// itself, which the dashboard cannot reply to.
//
// Call it from your OWN server route handlers, after persisting the row. `recorded: false` means
// the platform stored NOTHING — fall back to notifying the company inbox with sendEmail(), so the
// founder still hears about it. Never drop the submission on the floor.

import 'server-only';
import { proxyBaseUrl } from '@/lib/email/send';

/** The submission surfaces the proxy accepts. Anything else is rejected as `invalid_source`. */
export type SubmissionSource = 'contact_form' | 'waitlist';

export interface RecordSubmissionInput {
  source: SubmissionSource;
  /** The visitor's address, as typed. Becomes the mailbox row's `from`, so it is what a
   *  dashboard reply is addressed to. Rejected if it isn't a deliverable shape. */
  email: string;
  /** Visitor's name. Max 200 chars. */
  name?: string;
  /** The message body. Max 25 000 chars. Omit for a bare email capture (waitlist). */
  message?: string;
  /** Extra form fields, rendered into the dashboard row. Max 20 keys, 64-char keys,
   *  2 000-char values, 8 KiB total. Values must be string | number | boolean. */
  fields?: Record<string, string | number | boolean>;
  /** Dedupe handle for a retried submission — pass the DB row's id. Max 200 chars. */
  idempotencyKey?: string;
}

export interface RecordSubmissionResult {
  /**
   * `true` — the submission is in the founder's dashboard; you are done.
   * `false` — the platform recorded NOTHING and expects you to notify the company inbox by
   * email instead. Two causes, both routine: the company is not ramped onto the feature yet,
   * or this deployment predates the endpoint. Not an error, and not retryable.
   */
  recorded: boolean;
}

/**
 * Record a form submission. Returns `{ recorded }`; see {@link RecordSubmissionResult}.
 *
 * THROWS on anything anomalous — a validation rejection (a malformed address, an over-long
 * body), the daily cap, a transport failure. Those are real signals and are worth surfacing in
 * logs rather than swallowing. Callers still fall back to the email notification on a throw, so
 * an anomaly costs visibility, never the submission itself.
 */
export async function recordSubmission(
  input: RecordSubmissionInput,
): Promise<RecordSubmissionResult> {
  // POLSIA_API_KEY via process.env (platform-injected; not in typed env — ai/stripe declare it).
  const res = await fetch(`${proxyBaseUrl()}/submissions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.POLSIA_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      source: input.source,
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    }),
  });

  // 404 = this deployment predates the endpoint. Same meaning as the flag-off body below —
  // nothing was recorded, notify by email — so it is a value, not an exception.
  if (res.status === 404) return { recorded: false };

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`submission intake failed: ${res.status} ${detail}`.trim());
  }

  // { success, recorded, submission? } — `recorded: false` carries `reason: 'not_enabled'`.
  const json = (await res.json()) as { recorded?: boolean };
  return { recorded: json.recorded === true };
}
