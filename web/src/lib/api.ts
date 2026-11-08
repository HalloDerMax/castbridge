export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await parse(res)) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(data.error ?? `http_${res.status}`), data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {}),
  del: <T>(path: string, body?: unknown): Promise<T> => request<T>('DELETE', path, body ?? {}),

  /** Datei-Upload über multipart, für Ersatzbild/-video. */
  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
    const data = (await parse(res)) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, String(data.error ?? `http_${res.status}`), data);
    return data as T;
  },

  /**
   * Speedtest: lädt Zufallsdaten zum Server und nimmt den besten Durchlauf.
   * Mehrere Anläufe, weil der erste oft noch im Langsamstart hängt.
   */
  async speedtest(onProgress?: (pct: number) => void): Promise<number> {
    const sizes = [2, 6, 10];
    let best = 0;
    for (let i = 0; i < sizes.length; i++) {
      const bytes = sizes[i] * 1024 * 1024;
      const chunk = new Uint8Array(bytes);
      crypto.getRandomValues(chunk.subarray(0, Math.min(bytes, 65_536)));
      const started = performance.now();
      const res = await fetch('/api/speedtest/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: chunk,
      });
      if (!res.ok) throw new ApiError(res.status, 'speedtest_failed');
      const elapsed = Math.max(1, performance.now() - started);
      const mbps = (bytes * 8) / (elapsed / 1000) / 1_000_000;
      if (mbps > best) best = mbps;
      onProgress?.(Math.round(((i + 1) / sizes.length) * 100));
    }
    return Math.round(best * 100) / 100;
  },
};
