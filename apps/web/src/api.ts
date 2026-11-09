let csrfToken = '';
export type SessionInfo = { csrfToken: string; storageMode?: 'sqlite' | 'postgres'; authMode?: 'public' | 'supabase-jwt' };
export class ApiError extends Error {
  constructor(message:string,readonly status:number){super(message);this.name='ApiError';}
}
export async function initializeSession() {
  const session = await api<SessionInfo>('/session');
  csrfToken = session.csrfToken;
  return session;
}
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(method === 'GET' ? {} : {'x-csrf-token':csrfToken}) }, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
  const result = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new ApiError(typeof result.message === 'string' ? result.message : typeof result.error === 'string' ? result.error : `Request failed (${response.status}).`,response.status);
  return result;
}
export function download(name: string, body: string, type='application/json') {
  const url = URL.createObjectURL(new Blob([body],{type:`${type};charset=utf-8`}));
  const link = document.createElement('a'); link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function printable(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value,null,2);
}
