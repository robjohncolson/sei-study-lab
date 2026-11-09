import {
  AuthError, AuthRateLimiter, SESSION_SECONDS, buildSessionCookie, hashPassword,
  hashSessionToken, newSessionToken, normalizeUsername, readSessionCookie,
  setupCodeMatches, validatePassword, verifyPassword,
} from './core.js';

export type AuthIdentity = { ownerId: string; username: string };
export interface AuthStore {
  register(username: string, passwordHash: string, firstOwner: string, allowOpen: boolean, now: Date): Promise<string>;
  loginLookup(username: string, now: Date): Promise<{ ownerId: string; passwordHash: string; locked: boolean } | null>;
  loginResult(ownerId: string, success: boolean, now: Date): Promise<void>;
  createSession(tokenHash: string, ownerId: string, now: Date, expires: Date): Promise<void>;
  sessionOwner(tokenHash: string, now: Date): Promise<AuthIdentity | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  signupOpen(allowOpen: boolean): Promise<boolean>;
}
export type PasswordAuthConfig = {
  sessionSecret: string; firstOwner: string; allowSignup: boolean;
  setupCode?: string; origins: ReadonlySet<string>;
};

function credentials(body: unknown, signup: boolean) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, 'Invalid sign-in data');
  const record = body as Record<string, unknown>;
  const allowed = signup ? ['username', 'password', 'setupCode'] : ['username', 'password'];
  if (Object.keys(record).some(key => !allowed.includes(key)) ||
      (record.setupCode !== undefined && (typeof record.setupCode !== 'string' || Buffer.byteLength(record.setupCode) > 4096))) {
    throw new AuthError(400, 'Invalid sign-in data');
  }
  return { username: normalizeUsername(record.username), password: validatePassword(record.password), setupCode: record.setupCode };
}

export class AuthService {
  private readonly limiter = new AuthRateLimiter();
  constructor(private readonly store: AuthStore, private readonly config: PasswordAuthConfig, private readonly clock: () => Date = () => new Date()) {}

  async identity(cookie?: string): Promise<AuthIdentity | null> {
    const token = readSessionCookie(this.config.origins, cookie);
    return token ? this.store.sessionOwner(hashSessionToken(this.config.sessionSecret, token), this.clock()) : null;
  }

  async status(cookie?: string) {
    const identity = await this.identity(cookie);
    return { signedIn: Boolean(identity), username: identity?.username ?? null,
      signupOpen: await this.store.signupOpen(this.config.allowSignup), setupCodeRequired: this.config.setupCode !== undefined };
  }

  private limit(ip: string, username: string) {
    if (!this.limiter.take(ip, username, this.clock().getTime())) throw new AuthError(429, 'Too many sign-in attempts. Try again in a minute.');
  }

  private async session(ownerId: string) {
    const token = newSessionToken();
    const now = this.clock();
    await this.store.createSession(hashSessionToken(this.config.sessionSecret, token), ownerId, now, new Date(now.getTime() + SESSION_SECONDS * 1000));
    return { cookie: buildSessionCookie(this.config.origins, token) };
  }

  async signup(body: unknown, ip: string) {
    const input = credentials(body, true);
    this.limit(ip, input.username);
    if (this.config.setupCode !== undefined && !setupCodeMatches(this.config.sessionSecret, input.setupCode, this.config.setupCode)) {
      throw new AuthError(403, 'Sign-up is not available');
    }
    if (!await this.store.signupOpen(this.config.allowSignup)) throw new AuthError(403, 'Sign-up is closed');
    const passwordHash = await hashPassword(input.password);
    const owner = await this.store.register(input.username, passwordHash, this.config.firstOwner, this.config.allowSignup, this.clock());
    return this.session(owner);
  }

  async login(body: unknown, ip: string) {
    const input = credentials(body, false);
    this.limit(ip, input.username);
    const account = await this.store.loginLookup(input.username, this.clock());
    const valid = await verifyPassword(input.password, account?.passwordHash);
    // Locked and unknown accounts still pay the same password verification cost.
    if (!account || account.locked) throw new AuthError(401, 'Invalid username or password');
    await this.store.loginResult(account.ownerId, valid, this.clock());
    if (!valid || (await this.store.loginLookup(input.username, this.clock()))?.locked) {
      throw new AuthError(401, 'Invalid username or password');
    }
    return this.session(account.ownerId);
  }

  async logout(cookie?: string) {
    const token = readSessionCookie(this.config.origins, cookie);
    if (token) await this.store.revokeSession(hashSessionToken(this.config.sessionSecret, token), this.clock());
    return { cookie: buildSessionCookie(this.config.origins, null) };
  }
}

/** All other API routes, including future routes, require a password session. */
export function isPublicAuthRoute(url: string): boolean {
  const path = url.split('?')[0];
  return ['/api/session', '/api/catalog', '/api/anki.tsv', '/api/health'].includes(path) || path.startsWith('/api/auth/');
}
