import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}

export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32 || /[^a-z0-9._-]/i.test(value) || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(value.toLowerCase())) {
    throw new AuthError(400, 'Username must be 3–32 letters, numbers, dots, underscores or hyphens and start with a letter or number');
  }
  return value.toLowerCase();
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 200 || !/\S/u.test(value) || Buffer.byteLength(value, 'utf8') > 800) {
    throw new AuthError(400, 'Password must be 10–200 characters and contain a non-space character');
  }
  return value;
}

export function validateSessionSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096 || /[^A-Za-z0-9_-]/.test(value) ||
      !((value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)) || Buffer.from(value, 'base64url').toString('base64url') === value)) {
    throw new Error('SEI_SESSION_SECRET');
  }
  return value;
}

export function parseSignupSetting(value: string | undefined, name: string): boolean {
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error(name);
  return value === 'true';
}

const prefix = 'scrypt$32768$8$1$';
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error); else resolve(key);
  });
});

// A fixed, deliberately nonmatching credential. Unknown accounts still do one
// full scrypt operation. No actual password or credential hash is embedded here.
const dummyHash = `${prefix}${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${prefix}${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** A missing or malformed stored credential takes the fixed dummy-hash path. */
export async function verifyPassword(password: string, storedHash?: string | null): Promise<boolean> {
  const format = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
  const candidate = storedHash?.match(format);
  const match = candidate?.[0] === storedHash ? candidate : null;
  const parts = match ?? dummyHash.match(format)!;
  const salt = Buffer.from(parts[1], 'base64url');
  const expected = Buffer.from(parts[2], 'base64url');
  const actual = await derive(password, salt);
  const equal = timingSafeEqual(actual, expected);
  return Boolean(match) && equal && salt.toString('base64url') === parts[1] && expected.toString('base64url') === parts[2];
}

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const newSessionToken = () => randomBytes(32).toString('base64url');
export const hashSessionToken = (secret: string, token: string) => createHmac('sha256', secret).update(token).digest('hex');

export function setupCodeMatches(secret: string, supplied: unknown, expected: string): boolean {
  // Fixed-length HMAC digests make length differences safe to compare as well.
  const candidate = typeof supplied === 'string' && Buffer.byteLength(supplied) <= 4096 ? supplied : '';
  const equal = timingSafeEqual(Buffer.from(hashSessionToken(secret, candidate), 'hex'), Buffer.from(hashSessionToken(secret, expected), 'hex'));
  return typeof supplied === 'string' && equal;
}

export function sessionCookieSettings(origins: ReadonlySet<string>) {
  const local = origins.size > 0 && [...origins].every(origin => {
    try {
      const url = new URL(origin);
      return url.origin === origin && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    } catch { return false; }
  });
  return { name: local ? 'sei_session' : '__Host-sei_session', secure: !local };
}

export function buildSessionCookie(origins: ReadonlySet<string>, token: string | null): string {
  const { name, secure } = sessionCookieSettings(origins);
  if (token !== null && (token.length !== 43 || /[^A-Za-z0-9_-]/.test(token))) throw new Error('Invalid session token');
  return `${name}=${token ?? ''}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${token === null ? 0 : SESSION_SECONDS}`;
}

export function readSessionCookie(origins: ReadonlySet<string>, header?: string): string | null {
  const { name } = sessionCookieSettings(origins);
  const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return value.length === 43 && !/[^A-Za-z0-9_-]/.test(value) ? value : null;
}

/** Per-process IP and username buckets; bounded memory without evicting live limits. */
export class AuthRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly maxBuckets: number;
  constructor(capacity = 10, intervalMs = 60_000, maxBuckets = 10_000) {
    this.capacity = capacity; this.intervalMs = intervalMs; this.maxBuckets = maxBuckets;
  }
  take(ip: string, username: string, now = Date.now()): boolean {
    for (const [key, bucket] of this.buckets) if (now - bucket.at >= this.intervalMs) this.buckets.delete(key);
    const keys = [`ip:${ip}`, `user:${username}`];
    const missing = keys.filter(key => !this.buckets.has(key)).length;
    if (this.buckets.size + missing > this.maxBuckets) return false;
    const buckets = keys.map(key => {
      const previous = this.buckets.get(key);
      return { tokens: previous ? Math.min(this.capacity, previous.tokens + Math.max(0, now - previous.at) * this.capacity / this.intervalMs) : this.capacity, at: now };
    });
    if (buckets.some(bucket => bucket.tokens < 1)) return false;
    keys.forEach((key, index) => this.buckets.set(key, { ...buckets[index], tokens: buckets[index].tokens - 1 }));
    return true;
  }
}
