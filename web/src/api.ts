export type Role = "User" | "Admin";

export interface User {
  id: number;
  email: string;
  first_name: string;
  timezone: string | null;
  role: Role;
  upstream: string | null;
  disabled: number;
  created_at: number;
  updated_at: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(body?.error || response.statusText, response.status);
  }
  return body as T;
}

export const api = {
  me: () => request<{ user: User }>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  acceptInvite: (token: string, password: string, timezone: string) =>
    request<{ user: User }>("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, password, timezone }),
    }),
  listUsers: () => request<{ users: User[] }>("/api/admin/users"),
  createUser: (email: string, first_name: string, role: Role, upstream: string) =>
    request<{ user: User; invite_token: string }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, first_name, role, upstream }),
    }),
  updateUser: (id: number, patch: Record<string, unknown>) =>
    request<{ user: User }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  resetPassword: (id: number) =>
    request<{ user: User; invite_token: string }>(`/api/admin/users/${id}/reset-password`, {
      method: "POST",
    }),
  deleteUser: (id: number) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
};

/** The invitee's own timezone, read from their browser at the moment they accept. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function inviteLink(token: string): string {
  return `${window.location.origin}/accept-invite?token=${token}`;
}
