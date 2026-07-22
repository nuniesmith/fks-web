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
