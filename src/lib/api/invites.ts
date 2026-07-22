// Typed wrapper for the `/api/invites` admin surface, over the `api` object
// (client.ts). Every mutation is POST (the client exposes get/post/delete and
// there is no hard DELETE — revoke is an UPDATE, mirroring the users surface).

import { api } from "./client";
import type { OkResponse } from "$lib/types/users";
import type {
  CreateInviteResponse,
  InviteRole,
  InvitesListResponse,
} from "$lib/types/invites";

export const invitesApi = {
  list: () => api.get<InvitesListResponse>("/api/invites"),
  create: (role: InviteRole, ttlHours?: number) =>
    api.post<CreateInviteResponse>(
      "/api/invites",
      ttlHours !== undefined ? { role, ttlHours } : { role },
    ),
  revoke: (id: number) => api.post<OkResponse>(`/api/invites/${id}/revoke`),
};
