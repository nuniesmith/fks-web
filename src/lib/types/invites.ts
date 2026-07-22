// Client-facing shapes for the `/api/invites` admin surface (Phase C). Dates
// arrive as ISO strings (JSON), never Date objects. A one-time invite grants
// operator or viewer ONLY — never admin (server-enforced, mirrors the DB CHECK).

export type InviteRole = "operator" | "viewer";

export type InviteStatus = "active" | "expired" | "redeemed" | "revoked";

export interface InviteSummary {
  id: number;
  role: string;
  /** Username of the admin who minted it. */
  createdBy: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  expiresAt: string;
  status: InviteStatus;
}

export interface InvitesListResponse {
  invites: InviteSummary[];
}

export interface CreateInviteResponse {
  ok: true;
  /** RELATIVE claim path `/invite/<raw token>` — shown to the admin ONCE and
   *  never retrievable again. The admin's browser origin completes the URL. */
  url: string;
}
