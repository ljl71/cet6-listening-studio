export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `请求未完成（${response.status}）`);
  }
  return response.json();
}

export const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds || 0) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds || 0) % 60).toString().padStart(2, '0')}`;
export const dateLabel = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未练习';
export const safeStorage = { get(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }, set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* UI preferences are optional. */ } } };
