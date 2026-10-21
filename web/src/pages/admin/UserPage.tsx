import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, ApiError, avatarUrl, inviteLink, prepareAvatar } from "../../api";
import type { Role, User } from "../../api";
import { CameraIcon, ChevronLeftIcon } from "blode-icons-react";
import {
  accentStyle,
  formatDate,
  InviteNotice,
  PendingBar,
  pickImage,
  useAdmin,
} from "./shared";

/** How long the page waits for an Apply's host reconcile before it stops
 *  polling. The reconciler runs on the systemd event, so this is only a bound
 *  on the spinner, not a timeout on the work. */
const VM_APPLY_POLL_MS = 2000;
const VM_APPLY_POLL_TRIES = 45;

/** What the account asks the host for. Nulls inherit the deployment. */
function vmDesiredSpec(user: User): string {
  if (user.vm_memory_gb == null && user.vm_cpu_count == null) {
    return "the deployment's default sizing";
  }
  const memory = user.vm_memory_gb == null ? "default RAM" : `${user.vm_memory_gb} GB`;
  const cpu = user.vm_cpu_count == null ? "default vCPUs" : `${user.vm_cpu_count} vCPU`;
  return `${memory} / ${cpu}`;
}

/** What the host last wrote back. A null applied-at means it has not run. */
function vmAppliedSummary(user: User): string {
  if (user.vm_applied_at == null) return "Not applied yet";
  const cpu = user.vm_applied_cpu_count == null ? "?" : `${user.vm_applied_cpu_count} vCPU`;
  const memory = user.vm_applied_memory_gb == null ? "?" : `${user.vm_applied_memory_gb} GB`;
  return `${cpu} / ${memory} · ${formatDate(user.vm_applied_at)}`;
}

/** True when the stored spec is what the host applied. A field left null
 *  inherits the deployment, so only the fields the account sets are compared. */
function savedSpecApplied(user: User): boolean {
  if (user.vm_applied_at == null) return false;
  const cpuMatches =
    user.vm_cpu_count == null || user.vm_applied_cpu_count === user.vm_cpu_count;
  const memoryMatches =
    user.vm_memory_gb == null || user.vm_applied_memory_gb === user.vm_memory_gb;
  return cpuMatches && memoryMatches;
}

/** One of the two sizing sliders. The ticks and the track are drawn behind a
 *  native range input so keyboard and touch behaviour stay the browser's. */
function Slider({
  label,
  min,
  max,
  value,
  display,
  spoken,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  display: ReactNode;
  spoken: string;
  onChange: (value: number) => void;
}) {
  const ticks = Array.from({ length: max - min + 1 });
  return (
    <div className="admin-slider">
      <span className="admin-field-label">{label}</span>
      <div className="admin-slider-track">
        <span className="admin-slider-ticks" aria-hidden="true">
          {ticks.map((_, index) => (
            <span key={index} />
          ))}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={label}
          aria-valuetext={spoken}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      <span className="admin-slider-value">{display}</span>
    </div>
  );
}

/** A single account's page: who they are, the Cowork VM's sizing, and the
 *  actions that change their access. Details and sizing share one pending bar,
 *  so nothing reaches the server until Apply. */
export function UserPage({ id }: { id: number }) {
  const { navigate } = useAdmin();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("User");
  const [apiKey, setApiKey] = useState("");
  const [upstream, setUpstream] = useState("");
  const [cpu, setCpu] = useState(4);
  const [memory, setMemory] = useState(8);
  const [cpuOverride, setCpuOverride] = useState(false);
  const [memoryOverride, setMemoryOverride] = useState(false);

  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [vmBusy, setVmBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [vmNote, setVmNote] = useState("");
  const [invite, setInvite] = useState<{ label: string; url: string } | null>(null);

  /** Point the form at a user as the server knows them. */
  const adopt = useCallback((next: User) => {
    setName(next.first_name);
    setRole(next.role);
    setApiKey("");
    setUpstream(next.upstream ?? "");
    setCpu(next.vm_cpu_count ?? next.vm_applied_cpu_count ?? 4);
    setMemory(next.vm_memory_gb ?? next.vm_applied_memory_gb ?? 8);
    setCpuOverride(next.vm_cpu_count != null);
    setMemoryOverride(next.vm_memory_gb != null);
  }, []);

  const fetchUser = useCallback(async (): Promise<User | null> => {
    const { users } = await api.listUsers();
    return users.find((entry) => entry.id === id) ?? null;
  }, [id]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const found = await fetchUser();
        if (!found) {
          setUser(null);
          setLoadError("That account no longer exists.");
        } else {
          setUser(found);
          adopt(found);
        }
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "could not load the account");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchUser, adopt]);

  const nameChanged = user ? name.trim() !== user.first_name : false;
  const roleChanged = user ? role !== user.role : false;
  const keyChanged = apiKey.trim().length > 0;
  const upstreamChanged = user ? upstream.trim() !== (user.upstream ?? "") : false;
  const detailsDirty = nameChanged || roleChanged || keyChanged || upstreamChanged;
  const vmDirty = user
    ? cpuOverride !== (user.vm_cpu_count != null) ||
      (cpuOverride && cpu !== user.vm_cpu_count) ||
      memoryOverride !== (user.vm_memory_gb != null) ||
      (memoryOverride && memory !== user.vm_memory_gb)
    : false;
  const vmPending = user
    ? Boolean(user.upstream) && !user.disabled && !savedSpecApplied(user)
    : false;
  const showBar = Boolean(user) && (detailsDirty || vmDirty || vmPending);

  async function waitForApplied(baseline: User) {
    for (let attempt = 0; attempt < VM_APPLY_POLL_TRIES; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, VM_APPLY_POLL_MS));
      const fresh = await fetchUser();
      if (!fresh) return;
      setUser(fresh);
      if (
        fresh.vm_applied_at !== baseline.vm_applied_at ||
        fresh.vm_applied_memory_gb !== baseline.vm_applied_memory_gb ||
        fresh.vm_applied_cpu_count !== baseline.vm_applied_cpu_count
      ) {
        setVmNote(`Applied: ${vmAppliedSummary(fresh)}.`);
        return;
      }
    }
    setVmNote(
      "Still queued — the reconciler has not run yet. It retries on its timer; check back.",
    );
  }

  /** Commit the form: details first, then the desired sizing, then — if the
   *  saved sizing is not what the host has — the recreate that makes it so. */
  async function applyChanges() {
    if (!user) return;
    if (detailsDirty && !name.trim()) {
      setError("A first name is required.");
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    const hadDetails = detailsDirty;
    const hadVm = vmDirty;
    try {
      if (hadDetails) {
        const patch: Record<string, unknown> = {};
        if (nameChanged) patch.first_name = name.trim();
        if (roleChanged) patch.role = role;
        if (upstreamChanged) patch.upstream = upstream.trim();
        if (keyChanged) patch.upstream_api_key = apiKey.trim();
        const { user: saved } = await api.updateUser(user.id, patch);
        setUser(saved);
      }
      if (hadVm) {
        const { user: saved } = await api.updateUserVm(user.id, {
          memory_gb: memoryOverride ? memory : null,
          cpu_count: cpuOverride ? cpu : null,
        });
        setUser(saved);
      }

      const fresh = await fetchUser();
      if (!fresh) {
        setLoadError("That account no longer exists.");
        return;
      }
      setUser(fresh);
      adopt(fresh);
      if (hadDetails || hadVm) setNote("Saved.");

      const wantsRecreate = Boolean(fresh.upstream) && !fresh.disabled && !savedSpecApplied(fresh);
      if (wantsRecreate) {
        const spec = vmDesiredSpec(fresh);
        if (
          window.confirm(
            `Recreate ${fresh.email}'s instance with ${spec}?\n\n`
              + "This stops its VM and interrupts any running turns.",
          )
        ) {
          setVmNote("Apply queued; waiting for the host reconciler…");
          await api.applyUserVm(fresh.id);
          await waitForApplied(fresh);
        } else {
          setVmNote(
            "Spec saved. The instance keeps its current sizing until you apply.",
          );
        }
      } else if (hadVm) {
        setVmNote("The instance already matches the saved sizing.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save the account");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    if (!user) return;
    adopt(user);
    setError("");
    setNote("");
    setVmNote("");
  }

  async function changePhoto() {
    if (!user) return;
    const file = await pickImage();
    if (!file) return;
    setPhotoBusy(true);
    setError("");
    try {
      const photo = await prepareAvatar(file);
      const { user: saved } = await api.setAvatar(user.id, photo);
      setUser(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save the photo");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    if (!user) return;
    setPhotoBusy(true);
    setError("");
    try {
      const { user: saved } = await api.clearAvatar(user.id);
      setUser(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not remove the photo");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function clearApiKey() {
    if (!user) return;
    if (
      !window.confirm(
        `Clear ${user.email}'s API key?\n\nTheir workspace stops working until a new key is set.`,
      )
    ) {
      return;
    }
    setError("");
    try {
      const { user: saved } = await api.updateUser(user.id, { upstream_api_key: "" });
      setUser(saved);
      setNote("API key cleared.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not clear the API key");
    }
  }

  async function resetPassword() {
    if (!user) return;
    if (
      !window.confirm(
        `Reset ${user.email}'s password?\n\n`
          + "Their sessions are revoked and they get a new invite link. "
          + "Their current password stops working.",
      )
    ) {
      return;
    }
    setError("");
    try {
      const { user: saved, invite_token } = await api.resetPassword(user.id);
      setUser(saved);
      setInvite({ label: saved.email, url: inviteLink(invite_token) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reset the password");
    }
  }

  async function toggleDisabled() {
    if (!user) return;
    const disable = !user.disabled;
    if (
      disable &&
      !window.confirm(
        `Disable ${user.email}?\n\n`
          + "Their sessions are revoked and their workspace stops accepting connections.",
      )
    ) {
      return;
    }
    setError("");
    setNote("");
    try {
      const { user: saved } = await api.updateUser(user.id, { disabled: disable });
      setUser(saved);
      setNote(disable ? "Account disabled." : "Account enabled.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not change the account");
    }
  }

  async function deleteUser() {
    if (!user) return;
    if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    setError("");
    try {
      await api.deleteUser(user.id);
      navigate("/admin/users");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not delete the account");
    }
  }

  async function restartVm() {
    if (!user) return;
    if (!window.confirm(`Restart ${user.email}'s VM?\n\nAny running turns are interrupted.`)) {
      return;
    }
    setVmNote("Restarting the VM…");
    setVmBusy(true);
    try {
      const { vm } = await api.restartUserVm(user.id);
      setVmNote(vm?.running === false ? "Restart requested." : "VM restarted.");
      window.setTimeout(() => void checkVmStatus(), 3000);
    } catch (err) {
      setVmNote(err instanceof ApiError ? err.message : "could not restart the VM");
    } finally {
      setVmBusy(false);
    }
  }

  async function checkVmStatus() {
    if (!user) return;
    setVmBusy(true);
    try {
      const { vm } = await api.userVmStatus(user.id);
      const state =
        vm?.running === false ? "stopped" : vm?.pid ? `running (pid ${vm.pid})` : "unknown";
      setVmNote(
        `VM ${state}${typeof vm?.reason === "string" && vm.reason ? ` · ${vm.reason}` : ""}.`,
      );
    } catch (err) {
      setVmNote(err instanceof ApiError ? err.message : "could not read the VM status");
    } finally {
      setVmBusy(false);
    }
  }

  function resetVmDefaults() {
    if (!user) return;
    setCpu(user.vm_applied_cpu_count ?? 4);
    setMemory(user.vm_applied_memory_gb ?? 8);
    setCpuOverride(false);
    setMemoryOverride(false);
    setVmNote("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (showBar && !busy) void applyChanges();
  }

  if (loading) {
    return (
      <div className="admin-page">
        <p className="admin-loading-inline">Loading account…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="admin-page">
        <button
          type="button"
          className="admin-back"
          onClick={() => navigate("/admin/users")}
        >
          <ChevronLeftIcon size={18} />
          Users
        </button>
        <p className="admin-error" role="alert">
          {loadError || "That account no longer exists."}
        </p>
      </div>
    );
  }

  const initial =
    Array.from(name.trim() || user.first_name || user.email)[0]?.toUpperCase() ?? "?";
  const photo = avatarUrl(user);

  return (
    <form className="admin-page" onSubmit={submit} noValidate>
      <button
        type="button"
        className="admin-back"
        onClick={() => navigate("/admin/users")}
      >
        <ChevronLeftIcon size={18} />
        Users
      </button>

      {invite ? (
        <InviteNotice
          label={invite.label}
          url={invite.url}
          onDismiss={() => setInvite(null)}
        />
      ) : null}

      {error ? (
        <p className="admin-error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="admin-note admin-note--success" role="status">
          {note}
        </p>
      ) : null}

      <section className="admin-section">
        <h2 className="admin-section-title">Details</h2>
        <div className="admin-details">
          <div className="admin-avatar-col">
            <button
              type="button"
              className="admin-avatar"
              style={accentStyle(user.id)}
              onClick={() => void changePhoto()}
              disabled={photoBusy}
              aria-label={`Change ${user.first_name || user.email}'s photo`}
            >
              {photo ? (
                <img src={photo} alt="" />
              ) : (
                <span className="admin-avatar-initial" aria-hidden="true">
                  {initial}
                </span>
              )}
              <span className="admin-avatar-veil" aria-hidden="true">
                <CameraIcon size={20} />
                <span>{photoBusy ? "Uploading…" : "Change photo"}</span>
              </span>
            </button>
            {user.avatar_updated_at ? (
              <button
                type="button"
                className="admin-text-btn"
                onClick={() => void removePhoto()}
                disabled={photoBusy}
              >
                Remove photo
              </button>
            ) : null}
          </div>

          <div className="admin-fields">
            <div className="admin-field">
              <label className="admin-field-label" htmlFor="admin-user-name">
                Name
              </label>
              <input
                id="admin-user-name"
                className="admin-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Their first name"
                maxLength={80}
                autoComplete="off"
              />
            </div>

            <div className="admin-field">
              <div className="admin-field-label">
                <label htmlFor="admin-user-email">Email</label>
                <button
                  type="button"
                  className="admin-text-btn"
                  onClick={() => void resetPassword()}
                >
                  Reset password
                </button>
              </div>
              <input
                id="admin-user-email"
                className="admin-input"
                value={user.email}
                readOnly
              />
            </div>

            <div className="admin-field">
              <label className="admin-field-label" htmlFor="admin-user-role">
                Role
              </label>
              <select
                id="admin-user-role"
                className="admin-input admin-select"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                <option value="User">User</option>
                <option value="Admin">Admin</option>
              </select>
            </div>

            <div className="admin-field">
              <div className="admin-field-label">
                <label htmlFor="admin-user-key">API key</label>
                {user.api_key_updated_at ? (
                  <button
                    type="button"
                    className="admin-text-btn"
                    onClick={() => void clearApiKey()}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              <input
                id="admin-user-key"
                className="admin-input"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Leave blank to keep current"
                maxLength={200}
                autoComplete="new-password"
              />
            </div>

            <div className="admin-field">
              <label className="admin-field-label" htmlFor="admin-user-instance">
                Instance
              </label>
              <input
                id="admin-user-instance"
                className="admin-input"
                value={upstream}
                onChange={(event) => setUpstream(event.target.value)}
                placeholder="Not provisioned (host:port)"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
        </div>
        <p className="admin-meta" id="admin-user-email-note">
          Timezone {user.timezone || "—"} · Joined {formatDate(user.created_at)}
          {user.disabled ? " · Disabled" : ""}
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-section-title">Virtual Machine</h2>
        <div className="admin-vm">
          <Slider
            label="vCPUs"
            min={1}
            max={8}
            value={cpu}
            spoken={`${cpu} vCPU${cpu === 1 ? "" : "s"}${cpuOverride ? "" : ", inherited"}`}
            display={
              <>
                {cpu} vCPU{cpu === 1 ? "" : "s"}
                {cpuOverride ? null : (
                  <span className="admin-slider-inherited">inherited</span>
                )}
              </>
            }
            onChange={(next) => {
              setCpu(next);
              setCpuOverride(true);
              setVmNote("");
            }}
          />
          <Slider
            label="RAM"
            min={1}
            max={16}
            value={memory}
            spoken={`${memory} GB${memoryOverride ? "" : ", inherited"}`}
            display={
              <>
                {memory} GB
                {memoryOverride ? null : (
                  <span className="admin-slider-inherited">inherited</span>
                )}
              </>
            }
            onChange={(next) => {
              setMemory(next);
              setMemoryOverride(true);
              setVmNote("");
            }}
          />
        </div>
        <div className="admin-vm-foot">
          <span>Applied: {vmAppliedSummary(user)}</span>
          <button
            type="button"
            className="admin-text-btn"
            onClick={() => void checkVmStatus()}
            disabled={!user.internal_upstream || vmBusy}
          >
            Check status
          </button>
          {cpuOverride || memoryOverride ? (
            <button type="button" className="admin-text-btn" onClick={resetVmDefaults}>
              Use deployment default
            </button>
          ) : null}
        </div>
        {vmNote ? <p className="admin-note">{vmNote}</p> : null}
      </section>

      <section className="admin-section">
        <h2 className="admin-section-title">Actions</h2>
        <div className="admin-actions">
          <button
            type="button"
            className="admin-btn"
            onClick={() => void restartVm()}
            disabled={!user.internal_upstream || vmBusy}
          >
            Restart VM
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--warning"
            onClick={() => void toggleDisabled()}
          >
            {user.disabled ? "Enable" : "Disable"}
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--danger"
            onClick={() => void deleteUser()}
          >
            Delete
          </button>
        </div>
      </section>

      {showBar ? (
        <PendingBar
          text="You have unapplied changes."
          action="Apply"
          busyLabel="Applying…"
          busy={busy}
          onAction={() => void applyChanges()}
          onDiscard={detailsDirty || vmDirty ? discard : undefined}
        />
      ) : null}
    </form>
  );
}
