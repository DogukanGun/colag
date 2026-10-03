export type User = {
  id: string;
  email: string;
  displayName: string;
  createdAt?: string;
};
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api(url: string, options?: { method?: string; body?: unknown }) {
  const method = options?.method || (options?.body ? "POST" : "GET");
  const r = await fetch("/api/v1" + url, {
    credentials: "include",
    method,
    headers:
      options?.body !== undefined
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          }
        : undefined,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new ApiError(data.error || "Request failed", r.status, data.code || "");
  return data;
}
export function initials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}
