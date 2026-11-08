let csrfToken = '';
export async function initializeSession() {
  const session = await api<{csrfToken:string}>('/session');
  csrfToken = session.csrfToken;
}
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(method === 'GET' ? {} : {'x-csrf-token':csrfToken}) }, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
  const result = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : typeof result.error === 'string' ? result.error : `Request failed (${response.status}).`);
  return result;
}
export function download(name: string, body: string, type='application/json') {
  const url = URL.createObjectURL(new Blob([body],{type:`${type};charset=utf-8`}));
  const link = document.createElement('a'); link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function printable(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value,null,2);
}
