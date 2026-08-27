const TOKEN_KEY = 'soloops.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload?: unknown,
  ) {
    super(message)
  }
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, unknown> } = {},
): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value))
  }

  const token = getToken()
  const res = await fetch(url, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  if (res.status === 401) {
    setToken(null)
    if (!location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError(401, 'Nicht angemeldet')
  }

  const text = await res.text()
  const payload = text ? safeJson(text) : null

  if (!res.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    throw new ApiError(res.status, message, payload)
  }
  return payload as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),

  /** Multipart-Upload (Meeting-Aufnahmen) — eigener Pfad ohne JSON-Header. */
  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData()
    form.append('file', file)
    const token = getToken()
    const res = await fetch(path, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    if (!res.ok) throw new ApiError(res.status, (await res.text()).slice(0, 300))
    return (await res.json()) as T
  },
}
