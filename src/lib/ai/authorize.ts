// @polsia:user-owned
//
// Who may call POST /api/ai/chat. Return null to allow, or a Response to refuse
// (the route returns it and never calls the AI proxy). Edit in place, keep the
// signature, and do not read the body here (use req.clone()).
//
// DISABLED: no page or component of the app calls /api/ai/chat (the support
// widget uses /api/solco-support and the admin assistant /api/admin/assistant,
// both with their own server-side prompt and model). The framework route relays
// whatever model and system prompt the caller sends, billed to the app owner,
// so every caller is refused here before the body is read or the proxy called.
//
// To re-enable it for a real screen, refuse in this order: a mutating request
// without sameOrigin(req) (403), a request without a signed-in session (401),
// an oversized or invalid body (413/400, via readJsonLimited on req.clone()),
// any client-chosen `model`, `task` or `system` message (400), then
// enforceRateLimit('ai.chat', getRateLimitIdentity(session.user.id, req.headers)).

import 'server-only';

export async function authorizeAiChat(_req: Request): Promise<Response | null> {
  return Response.json(
    { error: 'not_found' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  );
}
