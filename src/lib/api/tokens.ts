// Typed client for the caller's own API tokens (`/api/tokens`, session only).

import { api } from "./client";
import type { ApiTokenList, CreateApiTokenRequest, CreateApiTokenResponse } from "$lib/types/tokens";

export const tokens = {
  list: () => api.get<ApiTokenList>("/api/tokens"),
  create: (req: CreateApiTokenRequest) => api.post<CreateApiTokenResponse>("/api/tokens", req),
  revoke: (id: number) => api.post<{ ok: boolean }>(`/api/tokens/${id}/revoke`, {}),
};
