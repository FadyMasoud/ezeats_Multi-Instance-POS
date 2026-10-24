import type { CheckDetails, ListFilters, SyncList, SyncStatus, SyncSummary } from './types';

const BASE = '/api';
export const PAGE_SIZE = 25;

/** An HTTP error carrying the backend's own message, so the UI never invents one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

async function request<T>(token: string, method: 'GET' | 'POST', path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'x-admin-token': token, accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the API. Check that the backend is running.');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const b = (body ?? {}) as { message?: unknown; code?: unknown };
    const message = Array.isArray(b.message)
      ? b.message.join('; ')
      : typeof b.message === 'string'
        ? b.message
        : `Request failed with HTTP ${response.status}`;
    throw new ApiError(response.status, message, typeof b.code === 'string' ? b.code : null);
  }
  return body as T;
}

export function createClient(token: string) {
  return {
    session: () => request<{ ok: true }>(token, 'GET', '/admin/session'),
    summary: () => request<SyncSummary>(token, 'GET', '/admin/sync/summary'),
    list: (filters: ListFilters) => {
      const params = new URLSearchParams({
        page: String(filters.page),
        pageSize: String(PAGE_SIZE),
      });
      if (filters.status) params.set('status', filters.status);
      if (filters.restaurantId) params.set('restaurantId', filters.restaurantId);
      if (filters.errorKind) params.set('errorKind', filters.errorKind);
      if (filters.q.trim()) params.set('q', filters.q.trim());
      return request<SyncList>(token, 'GET', `/admin/sync?${params}`);
    },
    details: (checkId: string) => request<CheckDetails>(token, 'GET', `/admin/checks/${checkId}`),
    retry: (checkId: string) => request<SyncStatus>(token, 'POST', `/checks/${checkId}/sync/retry`),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
