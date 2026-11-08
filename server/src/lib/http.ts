export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} bei ${url}: ${body.slice(0, 400)}`);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | Buffer;
  timeoutMs?: number;
}

export async function request(url: string, opts: FetchOptions = {}): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body as unknown as undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { status, text } = await request(url, opts);
  if (status < 200 || status >= 300) throw new HttpError(status, text, url);
  return (text === '' ? {} : JSON.parse(text)) as T;
}

export async function postJson<T>(url: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
  return getJson<T>(url, {
    ...opts,
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

export async function postForm<T>(url: string, form: Record<string, string>, opts: FetchOptions = {}): Promise<T> {
  return getJson<T>(url, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.headers ?? {}) },
    body: new URLSearchParams(form),
  });
}
