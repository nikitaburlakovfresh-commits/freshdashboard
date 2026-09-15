// Same-origin API client. Canonical app must be opened at its own origin
// (e.g. http://localhost:5173 via Vite proxy, or http://localhost:4000 if
// serving built client from Express) so the __Host-fresh_session cookie is
// sent — a sandboxed cross-origin iframe preview will not carry the cookie.

export interface ApiErrorBody {
  code: string;
  message: string;
  request_id: string;
  details: Record<string, unknown>;
}

export class ApiError extends Error {
  code: string;
  details: Record<string, unknown>;
  requestId: string;
  status: number;
  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.request_id;
    this.status = status;
  }
}

let csrfToken: string | null = null;
const pendingKeys = new Map<string,string>();

export function setCsrfToken(token: string | null) {
  if (token !== csrfToken) pendingKeys.clear();
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

function genIdempotencyKey(): string {
  // Fixed key format, unique per user click: crypto.randomUUID is 36 chars,
  // within the contract's 16-128 char / [A-Za-z0-9._:-] requirement.
  return crypto.randomUUID();
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotent?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotent = false, query } = opts;
  let url = `/api/v1${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const fingerprint = `${method}:${url}:${JSON.stringify(body ?? {})}`;
  if (method !== 'GET') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (idempotent) {
      if (!pendingKeys.has(fingerprint)) pendingKeys.set(fingerprint, genIdempotencyKey());
      headers['Idempotency-Key'] = pendingKeys.get(fingerprint)!;
    }
  }

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });

  if (res.status === 204) return undefined as T;

  const json = await res.json().catch(() => null);
  // Keep the original key after transport/5xx failure: commit outcome may
  // be unknown. A retry in this tab must not create a second business effect.
  if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429 &&
      json?.code !== 'IDEMPOTENCY_IN_PROGRESS')) pendingKeys.delete(fingerprint);
  if (!res.ok) {
    throw new ApiError(json ?? { code: 'UNKNOWN', message: 'Неизвестная ошибка сети.', request_id: '', details: {} }, res.status);
  }
  return json as T;
}
