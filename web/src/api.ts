export type Role = "User" | "Admin";

export interface User {
  id: number;
  email: string;
  first_name: string;
  timezone: string | null;
  role: Role;
  upstream: string | null;
  disabled: number;
  /** When the photo last changed; null means the account has none. */
  avatar_updated_at: number | null;
  /** When the account's own upstream API key last changed; null means it has
   *  none. The key itself is never sent to the browser. */
  api_key_updated_at: number | null;
  /** The Cowork VM sizing the admin asked for; null inherits the deployment. */
  vm_memory_gb: number | null;
  vm_cpu_count: number | null;
  /** What the host reconciler actually applied, and when (Unix seconds). */
  vm_applied_memory_gb: number | null;
  vm_applied_cpu_count: number | null;
  vm_applied_at: number | null;
  /** The instance's in-network address, written by the provisioner. Absent on
   *  an account that has not been deployed since this field was added. */
  internal_upstream: string | null;
  created_at: number;
  updated_at: number;
}

/** The VM monitor state an instance reports for the admin panel. */
export interface VmStatus {
  started?: boolean;
  running?: boolean;
  pid?: number | null;
  reason?: string;
  [key: string]: unknown;
}

/** A deployment-wide setting the admin page owns. The model picker's layout is
 *  the ordered list of models kept at the root of the composer's model menu,
 *  with every other configured model under "More models"; an empty list is the
 *  native layout — every model at the root. The configured model names the model
 *  the app's configuration health check probes, because Desktop otherwise picks
 *  one itself and reports it as the "configured model" when the gateway does not
 *  serve it; an empty string leaves that choice to Desktop. Each account's
 *  instance reads both from the auth service (`GET /api/auth/deployment`). */
export interface DeploymentSettings {
  model_picker_main_models: string[];
  configured_model: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(body?.error || response.statusText, response.status);
  }
  return body as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return parse<T>(
    await fetch(path, {
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...init,
    }),
  );
}

/** A raw-body request: `Content-Type` is the file's own, not JSON. */
async function requestBinary<T>(path: string, method: string, file: Blob): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method,
      credentials: "include",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }),
  );
}

export const api = {
  me: () => request<{ user: User }>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  acceptInvite: (
    token: string,
    password: string,
    timezone: string,
    first_name: string,
    upstream_api_key: string,
  ) =>
    request<{ user: User }>("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, password, timezone, first_name, upstream_api_key }),
    }),
  /** The signed-in person's own photo, uploaded right after accepting an invite. */
  uploadAvatar: (file: Blob) => requestBinary<{ user: User }>("/api/auth/me/avatar", "PUT", file),
  listUsers: () => request<{ users: User[] }>("/api/admin/users"),
  createUser: (email: string, role: Role) =>
    request<{ user: User; invite_token: string }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  updateUser: (id: number, patch: Record<string, unknown>) =>
    request<{ user: User }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  setAvatar: (id: number, file: Blob) =>
    requestBinary<{ user: User }>(`/api/admin/users/${id}/avatar`, "PUT", file),
  clearAvatar: (id: number) =>
    request<{ user: User }>(`/api/admin/users/${id}/avatar`, { method: "DELETE" }),
  resetPassword: (id: number) =>
    request<{ user: User; invite_token: string }>(`/api/admin/users/${id}/reset-password`, {
      method: "POST",
    }),
  deleteUser: (id: number) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  /** Save the desired Cowork VM sizing. Nothing is recreated until Apply. */
  updateUserVm: (id: number, spec: { memory_gb: number | null; cpu_count: number | null }) =>
    request<{ user: User }>(`/api/admin/users/${id}/vm`, {
      method: "PUT",
      body: JSON.stringify(spec),
    }),
  /** Queue the host reconcile that recreates the instance with the saved spec. */
  applyUserVm: (id: number) =>
    request<{ queued: true }>(`/api/admin/users/${id}/vm/apply`, { method: "POST" }),
  /** Restart the account's VM (its running turns are interrupted). */
  restartUserVm: (id: number) =>
    request<{ vm: VmStatus }>(`/api/admin/users/${id}/vm/restart`, { method: "POST" }),
  /** The instance's current VM monitor state. */
  userVmStatus: (id: number) =>
    request<{ vm: VmStatus }>(`/api/admin/users/${id}/vm/status`),
  getSettings: () => request<{ settings: DeploymentSettings }>("/api/admin/settings"),
  /** Write the settings named in the patch; keys left out keep their value. */
  updateSettings: (patch: Partial<DeploymentSettings>) =>
    request<{ settings: DeploymentSettings }>("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  /** The models this deployment's picker offers, each with the label it displays
   *  as (`GET /api/chat/model-catalog` on the instance this page's owner is
   *  routed to). Not an admin route: it reports the models the menu already shows
   *  that person. Empty when no page has been served yet and the deployment
   *  discovers its models instead of being handed a list, so the card must treat
   *  an empty or failed answer as "nothing to offer", not "no models". */
  modelCatalogue: () =>
    request<{ value: ModelOption[] }>("/api/chat/model-catalog").then((body) => body.value ?? []),
};

/** A model as the picker offers it: the id to pin, and the name it shows. */
export interface ModelOption {
  id: string;
  name: string;
}

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

/** A user's photo URL, cache-busted by its change time; "" when they have none. */
export function avatarUrl(user: User): string {
  if (!user.avatar_updated_at) return "";
  return `/api/auth/avatar/${user.id}?v=${user.avatar_updated_at}`;
}

const AVATAR_MAX_EDGE = 512;

/** Downscale and re-encode a chosen image so it fits authd's 2 MiB cap. Falls
 *  back to the original file when the browser cannot decode it. */
export async function prepareAvatar(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1_500_000) {
      bitmap.close();
      return file;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    return blob ?? file;
  } catch {
    return file;
  }
}
