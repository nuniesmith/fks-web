// Client-facing shapes for the `/api/users` admin surface (Phase B). Dates
// arrive as ISO strings (JSON), never Date objects — the server serialises the
// UserSummary Dates on the way out.

export type AssignableRole = "admin" | "operator" | "viewer";

export interface UserSummary {
  id: number;
  username: string;
  role: string;
  mustChange: boolean;
  disabled: boolean;
  /** ISO timestamp, or null when the account is not locked. */
  lockedUntil: string | null;
  /** ISO timestamp of account creation. */
  createdAt: string;
}

export interface UsersListResponse {
  users: UserSummary[];
}

export interface CreateUserResponse {
  ok: true;
  user: UserSummary;
  /** Shown to the admin ONCE — never retrievable again. */
  tempPassword: string;
}

export interface ResetPasswordResponse {
  ok: true;
  /** Shown to the admin ONCE — never retrievable again. */
  tempPassword: string;
}

export interface OkResponse {
  ok: true;
}

/** One row of the auth audit trail, as surfaced to the admin viewer (Phase D).
 *  `at` is an ISO timestamp string (JSON), never a Date. */
export interface AuditEvent {
  /** ISO timestamp of the event. */
  at: string;
  /** Target/subject username (may be "" for system rows). */
  username: string;
  /** Free-text action verb, e.g. login_ok / role_changed / invite_created. */
  action: string;
  ip: string;
  detail: string;
}

export interface AuditListResponse {
  events: AuditEvent[];
}
