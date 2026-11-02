// Personal access tokens (API v1) — mirrors `GET/POST /api/tokens`
// (src/lib/server/users.ts `tokensDispatch`, auth/service.ts).

/** Roles a token can carry. No admin tokens: admin-only actions need a session. */
export const API_TOKEN_ROLES = ["viewer", "operator"] as const;
/** Lifetimes the server accepts; a token always expires. */
export const API_TOKEN_TTL_DAYS = [7, 30, 90, 365] as const;

export interface ApiToken {
  id: number;
  name: string;
  roleCap: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
}

export interface ApiTokenList {
  /** False until fks 027 (`webui_api_tokens`) is applied on this server. */
  available: boolean;
  tokens: ApiToken[];
}

export interface CreateApiTokenRequest {
  name: string;
  role: string;
  ttlDays: number;
}

/** The mint response: `token` is the raw value, returned this once only. */
export interface CreateApiTokenResponse {
  ok: true;
  token: string;
  apiToken: Omit<ApiToken, "status">;
}
