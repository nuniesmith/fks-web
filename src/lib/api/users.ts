// Typed wrapper for the `/api/users` admin surface, over the `api` object
// (client.ts — `.get`/`.post`, it is NOT callable). Every mutation is POST: the
// B3 routes were shaped POST-only precisely because the client exposes only
// get/post/delete, and there is no hard DELETE (disable is the removal story).

import { api } from "./client";
import type {
  AssignableRole,
  AuditListResponse,
  CreateUserResponse,
  OkResponse,
  ResetPasswordResponse,
  UsersListResponse,
} from "$lib/types/users";

export const usersApi = {
  list: () => api.get<UsersListResponse>("/api/users"),
  create: (username: string, role: AssignableRole) =>
    api.post<CreateUserResponse>("/api/users", { username, role }),
  disable: (id: number) => api.post<OkResponse>(`/api/users/${id}/disable`),
  enable: (id: number) => api.post<OkResponse>(`/api/users/${id}/enable`),
  setRole: (id: number, role: AssignableRole) =>
    api.post<OkResponse>(`/api/users/${id}/role`, { role }),
  resetPassword: (id: number) =>
    api.post<ResetPasswordResponse>(`/api/users/${id}/reset-password`),
  revokeSessions: (id: number) =>
    api.post<OkResponse>(`/api/users/${id}/revoke-sessions`),
  // Recent auth events (newest first); the server clamps limit to [1, 500].
  audit: (limit = 100) =>
    api.get<AuditListResponse>(`/api/users/audit?limit=${limit}`),
};
