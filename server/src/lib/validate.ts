export class BadRequest extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'BadRequest';
  }
}

type Obj = Record<string, unknown>;

export function body(raw: unknown): Obj {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('invalid_body');
  return raw as Obj;
}

export function str(o: Obj, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new BadRequest(`missing_${key}`);
  }
  if (typeof v !== 'string') throw new BadRequest(`invalid_${key}`);
  const t = v.trim();
  if (opts.min !== undefined && t.length < opts.min) throw new BadRequest(`short_${key}`);
  if (opts.max !== undefined && t.length > opts.max) throw new BadRequest(`long_${key}`);
  return t;
}

export function int(o: Obj, key: string, opts: { min?: number; max?: number; fallback?: number } = {}): number {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new BadRequest(`missing_${key}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequest(`invalid_${key}`);
  const r = Math.round(n);
  if (opts.min !== undefined && r < opts.min) throw new BadRequest(`small_${key}`);
  if (opts.max !== undefined && r > opts.max) throw new BadRequest(`large_${key}`);
  return r;
}

export function bool(o: Obj, key: string, fallback = false): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new BadRequest(`invalid_${key}`);
}

export function strList(o: Obj, key: string, max = 100): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new BadRequest(`invalid_${key}`);
  return v.slice(0, max).map((x) => String(x).trim()).filter((x) => x !== '');
}

export function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], fallback?: T): T {
  const v = o[key];
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new BadRequest(`invalid_${key}`);
  return v as T;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(o: Obj, key = 'email'): string {
  const v = str(o, key, { max: 200 }).toLowerCase();
  if (!EMAIL.test(v)) throw new BadRequest('invalid_email');
  return v;
}

export function password(o: Obj, key = 'password'): string {
  const v = o[key];
  if (typeof v !== 'string') throw new BadRequest('missing_password');
  if (v.length < 10) throw new BadRequest('password_too_short');
  if (v.length > 200) throw new BadRequest('password_too_long');
  return v;
}
