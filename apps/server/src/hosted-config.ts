/** Environment parsing is separate from clients: invalid config never opens a connection. */
export class HostedConfigError extends Error {}

type HostedAuthentication =
  | { authMode: 'public'; supabaseUrl?: never; issuer?: never }
  | { authMode: 'supabase-jwt'; supabaseUrl: string; issuer: string };

export type HostedConfig = {
  databaseUrl: string;
  ownerUserId: string;
  origins: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
  poolMax: number;
  databaseCaPem?: string;
} & HostedAuthentication;

export const isUuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function readStorageMode(env: NodeJS.ProcessEnv = process.env): 'sqlite' | 'postgres' {
  if (env.STORAGE_MODE === undefined || env.STORAGE_MODE === 'sqlite') return 'sqlite';
  if (env.STORAGE_MODE === 'postgres') return 'postgres';
  throw new HostedConfigError('STORAGE_MODE must be sqlite or postgres');
}

const localHost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1';
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new HostedConfigError(`${name} is required in postgres mode`);
  return value;
}
function parseUrl(value: string, name: string): URL {
  try { return new URL(value); }
  catch { throw new HostedConfigError(`${name} must be a valid URL`); }
}

/** All errors identify the setting, never its value (URLs can carry credentials). */
export function readHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const authMode = required(env, 'HOSTED_AUTH_MODE');
  if (authMode !== 'public' && authMode !== 'supabase-jwt') {
    throw new HostedConfigError('HOSTED_AUTH_MODE must be public or supabase-jwt');
  }
  const databaseUrl = required(env, 'SEI_DATABASE_URL');
  const database = parseUrl(databaseUrl, 'SEI_DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname ||
      database.pathname.length < 2 || database.hash || database.search ||
      !/^sei_app(?:\.[a-z0-9]+)?$/.test(database.username)) {
    throw new HostedConfigError('SEI_DATABASE_URL must name sei_app (or its pooler user) and a database, without query options');
  }
  const ownerSetting = authMode === 'public' ? 'PUBLIC_OWNER_ID' : 'OWNER_USER_ID';
  const ownerUserId = required(env, ownerSetting);
  if (!isUuid(ownerUserId)) throw new HostedConfigError(`${ownerSetting} must be a UUID`);
  let authentication: HostedAuthentication;
  if (authMode === 'supabase-jwt') {
    const supabase = parseUrl(required(env, 'SUPABASE_URL'), 'SUPABASE_URL');
    if ((supabase.protocol !== 'https:' && !(supabase.protocol === 'http:' && localHost(supabase.hostname))) ||
        supabase.username || supabase.password || supabase.search || supabase.hash || supabase.pathname !== '/') {
      throw new HostedConfigError('SUPABASE_URL must be an HTTPS origin (HTTP is allowed only for localhost tests)');
    }
    authentication = { authMode, supabaseUrl: supabase.origin, issuer: `${supabase.origin}/auth/v1` };
  } else {
    authentication = { authMode };
  }
  const origins = new Set(required(env, 'APP_ORIGINS').split(',').map(value => value.trim()));
  for (const origin of origins) {
    const parsed = parseUrl(origin, 'APP_ORIGINS');
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHost(parsed.hostname)))) {
      throw new HostedConfigError('APP_ORIGINS must contain exact HTTPS origins (HTTP is allowed only for localhost tests)');
    }
  }
  const hosts = new Set(required(env, 'APP_HOSTS').split(',').map(value => value.trim()));
  for (const host of hosts) {
    const parsed = parseUrl(`https://${host}`, 'APP_HOSTS');
    const authority = host.match(/^(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/);
    if (!authority || parsed.hostname !== authority[1] ||
        (authority[2] !== undefined && (Number(authority[2]) < 1 || Number(authority[2]) > 65535)) ||
        parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new HostedConfigError('APP_HOSTS must contain exact hosts, optionally with ports, without schemes or paths');
    }
  }
  const poolMax = env.SEI_DATABASE_POOL_MAX === undefined ? 1 : Number(env.SEI_DATABASE_POOL_MAX);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 5) {
    throw new HostedConfigError('SEI_DATABASE_POOL_MAX must be an integer from 1 to 5');
  }
  const databaseCaPem = env.SEI_DATABASE_CA_PEM;
  if (databaseCaPem !== undefined && !databaseCaPem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new HostedConfigError('SEI_DATABASE_CA_PEM must contain a PEM certificate');
  }
  const common = { databaseUrl, ownerUserId, origins, hosts, poolMax,
    ...(databaseCaPem === undefined ? {} : { databaseCaPem }) };
  return { ...common, ...authentication };
}

export function databaseUsesTls(config: HostedConfig): boolean {
  return !localHost(new URL(config.databaseUrl).hostname) || config.databaseCaPem !== undefined;
}
