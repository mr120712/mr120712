// @polsia:user-owned

/**
 * Better Auth has no username field. Set this server-only value to the exact
 * Better Auth User.id only after an authoritative lookup confirms it belongs to
 * the Polsia username `bestmr12`. Never derive it from User.name or request data.
 */
export function getDesignatedAdminUserId(): string | undefined {
  return process.env.ADMIN_USER_ID?.trim() || undefined;
}
