import { FormEvent, Fragment, useEffect, useState } from "react";
import { api, ApiError, avatarUrl, inviteLink, ModelOption, prepareAvatar, Role, User } from "../api";

/** How long the page waits for an Apply's host reconcile before it stops
 *  polling. The reconciler runs on the systemd event, so this is only a bound
 *  on the spinner, not a timeout on the work. */
const VM_APPLY_POLL_MS = 2000;
const VM_APPLY_POLL_TRIES = 45;

function vmDesired(user: User): string {
  if (user.vm_memory_gb == null && user.vm_cpu_count == null) return "inherits";
  const memory = user.vm_memory_gb == null ? "default" : `${user.vm_memory_gb} GB`;
  const cpu = user.vm_cpu_count == null ? "default" : `${user.vm_cpu_count} vCPU`;
  return `${memory} / ${cpu}`;
}

function vmApplied(user: User): string {
  if (user.vm_applied_at == null) return "not applied yet";
  return `${user.vm_applied_memory_gb ?? "?"} GB / ${user.vm_applied_cpu_count ?? "?"} vCPU`;
}

/** Open the OS file picker and resolve with the chosen image, or null. */
function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export function AdminPage() {
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ label: string; url: string } | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("User");

  // The model picker's layout: the working copy the admin is editing, and what
  // the deployment currently has, so the form can tell whether it is dirty.
  const [mainModels, setMainModels] = useState<string[]>([]);
  const [savedModels, setSavedModels] = useState<string[]>([]);
  const [catalogue, setCatalogue] = useState<ModelOption[]>([]);
  // Why the card has no models to offer, when that is a failure rather than a
  // deployment that discovers its list. Shown so an empty card explains itself.
  const [catalogueError, setCatalogueError] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [newModel, setNewModel] = useState("");

  // The VM editor: which account's row is open, the two inputs, and the
  // transient result of Apply/Restart.
  const [vmEditing, setVmEditing] = useState<number | null>(null);
  const [vmMemory, setVmMemory] = useState("");
  const [vmCpu, setVmCpu] = useState("");
  const [vmBusy, setVmBusy] = useState<number | null>(null);
  const [vmNote, setVmNote] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { user } = await api.me();
        if (user.role !== "Admin") {
          window.location.assign("/");
          return;
        }
        setMe(user);
        await refresh();
        await refreshSettings();
      } catch {
        window.location.assign("/login");
      }
    })();
  }, []);

  async function refresh() {
    try {
      setUsers((await api.listUsers()).users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load users");
    }
  }

  async function refreshSettings() {
    try {
      const { settings } = await api.getSettings();
      setMainModels(settings.model_picker_main_models);
      setSavedModels(settings.model_picker_main_models);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the deployment settings");
    }
    // An empty answer is normal — a gateway in discovery mode reports nothing
    // until its instance has served a page — but a failed one is worth saying out
    // loud, or the card is just an unexplained empty list.
    try {
      setCatalogue(await api.modelCatalogue());
      setCatalogueError("");
    } catch (err) {
      setCatalogue([]);
      setCatalogueError(err instanceof ApiError ? `HTTP ${err.status}` : "no answer");
    }
  }

  /** Every model the card can show: the chosen ones first, in their order, then
   *  the rest of the catalogue. A pinned id the catalogue does not carry is still
   *  a row — it came from the setting and must stay visible and removable — and
   *  the filter narrows only the unchosen rows, so a chosen model cannot be
   *  filtered out of sight. */
  function pickerRows(): ModelOption[] {
    const rows: ModelOption[] = mainModels.map((id) => ({
      id,
      name: catalogue.find((model) => model.id.toLowerCase() === id.toLowerCase())?.name ?? id,
    }));
    const needle = modelFilter.trim().toLowerCase();
    for (const model of catalogue) {
      if (rows.some((row) => row.id.toLowerCase() === model.id.toLowerCase())) continue;
      if (needle && !`${model.name} ${model.id}`.toLowerCase().includes(needle)) continue;
      rows.push(model);
    }
    return rows;
  }

  function toggleModel(id: string) {
    setMainModels((current) =>
      current.some((chosen) => chosen.toLowerCase() === id.toLowerCase())
        ? current.filter((chosen) => chosen.toLowerCase() !== id.toLowerCase())
        : [...current, id],
    );
  }

  function moveModel(id: string, delta: number) {
    setMainModels((current) => {
      const from = current.findIndex((chosen) => chosen === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  }

  function addModel() {
    const id = newModel.trim();
    if (!id) return;
    setMainModels((current) =>
      current.some((chosen) => chosen.toLowerCase() === id.toLowerCase())
        ? current
        : [...current, id],
    );
    setNewModel("");
  }

  /** Write the working copy. The server trims, de-duplicates and bounds it, and
   *  its answer — not the local copy — is what the form shows afterwards. */
  async function saveModels(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { settings } = await api.updateSettings({ model_picker_main_models: mainModels });
      setMainModels(settings.model_picker_main_models);
      setSavedModels(settings.model_picker_main_models);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save the model picker");
    } finally {
      setBusy(false);
    }
  }

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "action failed");
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user, invite_token } = await api.createUser(email.trim(), role);
      setInvite({ label: user.email, url: inviteLink(invite_token) });
      setEmail("");
      setRole("User");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not create the account");
    }
    setBusy(false);
  }

  /** Admin edits of a person's details — the invitee normally sets these when
   *  they accept, but an admin can correct them afterwards. */
  function editName(user: User) {
    const next = window.prompt(`First name for ${user.email}`, user.first_name);
    if (next === null) return;
    void guard(() => api.updateUser(user.id, { first_name: next.trim() }));
  }

  /** Replace a person's upstream API key. The stored value is never sent to the
   *  browser, so this is a blind write; an empty value clears it. */
  function editApiKey(user: User) {
    const next = window.prompt(
      `API key for ${user.email} (empty to clear)`,
      "",
    );
    if (next === null) return;
    void guard(() => api.updateUser(user.id, { upstream_api_key: next.trim() }));
  }

  async function changePhoto(user: User) {
    const file = await pickImage();
    if (!file) return;
    const photo = await prepareAvatar(file);
    await guard(() => api.setAvatar(user.id, photo));
  }

  function clearPhoto(user: User) {
    void guard(() => api.clearAvatar(user.id));
  }

  function openVm(user: User) {
    setVmEditing(user.id);
    setVmMemory(user.vm_memory_gb == null ? "" : String(user.vm_memory_gb));
    setVmCpu(user.vm_cpu_count == null ? "" : String(user.vm_cpu_count));
    setVmNote(null);
  }

  function parseVmValue(raw: string, min: number, max: number, label: string): number | null {
    const text = raw.trim();
    if (!text) return null;
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be a whole number from ${min} to ${max}, or empty to inherit`);
    }
    return value;
  }

  async function saveVm(user: User) {
    setError("");
    let memory: number | null;
    let cpu: number | null;
    try {
      memory = parseVmValue(vmMemory, 1, 16, "Memory");
      cpu = parseVmValue(vmCpu, 1, 8, "vCPU");
    } catch (err) {
      setError(err instanceof Error ? err.message : "invalid VM spec");
      return;
    }
    try {
      const { user: saved } = await api.updateUserVm(user.id, {
        memory_gb: memory,
        cpu_count: cpu,
      });
      setUsers((current) => current.map((row) => (row.id === saved.id ? saved : row)));
      setVmNote({ id: user.id, text: "Saved. Apply recreates the instance with this spec." });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not save the VM spec");
    }
  }

  async function applyVm(user: User) {
    const spec = vmDesired(user);
    if (!window.confirm(
      `Recreate ${user.email}'s instance with ${spec}?\n\n`
      + "This stops its VM and interrupts any running turns.",
    )) return;
    setError("");
    setVmBusy(user.id);
    setVmNote({ id: user.id, text: "Apply queued; waiting for the host reconciler…" });
    const baseline = {
      at: user.vm_applied_at,
      memory: user.vm_applied_memory_gb,
      cpu: user.vm_applied_cpu_count,
    };
    try {
      await api.applyUserVm(user.id);
      for (let attempt = 0; attempt < VM_APPLY_POLL_TRIES; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, VM_APPLY_POLL_MS));
        const { users: next } = await api.listUsers();
        setUsers(next);
        const row = next.find((entry) => entry.id === user.id);
        if (row && (row.vm_applied_at !== baseline.at
          || row.vm_applied_memory_gb !== baseline.memory
          || row.vm_applied_cpu_count !== baseline.cpu)) {
          setVmNote({ id: user.id, text: `Applied: ${vmApplied(row)}.` });
          return;
        }
      }
      setVmNote({
        id: user.id,
        text: "Still queued — the reconciler has not run yet. It retries on its timer; check back.",
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not queue the VM apply");
      setVmNote(null);
    } finally {
      setVmBusy(null);
    }
  }

  async function restartVm(user: User) {
    if (!window.confirm(`Restart ${user.email}'s VM?\n\nAny running turns are interrupted.`)) return;
    setError("");
    setVmBusy(user.id);
    setVmNote({ id: user.id, text: "Restarting the VM…" });
    try {
      const { vm } = await api.restartUserVm(user.id);
      setVmNote({ id: user.id, text: vm?.running === false ? "Restart requested." : "VM restarted." });
      window.setTimeout(() => void pollVmStatus(user), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not restart the VM");
      setVmNote(null);
    } finally {
      setVmBusy(null);
    }
  }

  async function pollVmStatus(user: User) {
    try {
      const { vm } = await api.userVmStatus(user.id);
      const state = vm?.running === false
        ? "stopped"
        : vm?.pid ? `running (pid ${vm.pid})` : "unknown";
      setVmNote({
        id: user.id,
        text: `VM ${state}${typeof vm?.reason === "string" && vm.reason ? ` · ${vm.reason}` : ""}.`,
      });
    } catch (err) {
      setVmNote({
        id: user.id,
        text: err instanceof ApiError ? err.message : "could not read the VM status",
      });
    }
  }

  async function reset(user: User) {
    setError("");
    try {
      const { invite_token } = await api.resetPassword(user.id);
      setInvite({ label: user.email, url: inviteLink(invite_token) });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reset the password");
    }
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    window.location.assign("/login");
  }

  const pickerDirty =
    mainModels.length !== savedModels.length ||
    mainModels.some((id, index) => id.toLowerCase() !== savedModels[index].toLowerCase());

  if (!me) {
    return (
      <div className="shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="shell wide">
      <div className="head">
        <div>
          <h1>User management</h1>
          <p className="muted" style={{ margin: 0 }}>
            Signed in as {me.email}
          </p>
        </div>
        <button className="ghost" onClick={logout}>
          Sign out
        </button>
      </div>

      {error && (
        <p className="error" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </p>
      )}

      <form className="card panel" onSubmit={create}>
        <h2>Create a user</h2>
        <p className="muted" style={{ margin: 0 }}>
          Invite by email — the person sets their name, photo and their own API key
          when they accept.
        </p>
        <div className="row">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Role
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="User">User</option>
              <option value="Admin">Admin</option>
            </select>
          </label>
        </div>
        <div>
          <button disabled={busy}>{busy ? "Creating…" : "Create and show invite"}</button>
        </div>
      </form>

      {invite && (
        <div className="card panel invite" style={{ maxWidth: "none" }}>
          <strong>Invite link for {invite.label} — shown once.</strong>
          <code>{invite.url}</code>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={() => navigator.clipboard?.writeText(invite.url)}
            >
              Copy
            </button>
            <button type="button" className="ghost" onClick={() => setInvite(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th />
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Timezone</th>
            <th>Instance</th>
            <th>VM</th>
            <th>API key</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <Fragment key={user.id}>
              <tr>
                <td>
                  {avatarUrl(user) ? (
                    <img
                      className="avatar"
                      src={avatarUrl(user)}
                      alt=""
                      width={28}
                      height={28}
                    />
                  ) : (
                    <span className="avatar placeholder" aria-hidden="true" />
                  )}
                </td>
                <td>{user.first_name || "—"}</td>
                <td>{user.email}</td>
                <td>
                  <span className="tag">{user.role}</span>
                </td>
                <td className="muted">{user.timezone ?? "—"}</td>
                <td className="muted">
                  {user.disabled ? "disabled" : user.upstream || "no instance"}
                </td>
                <td className="muted">
                  <div>{vmDesired(user)}</div>
                  <div className="vm-applied">{vmApplied(user)}</div>
                </td>
                <td className="muted">
                  {user.api_key_updated_at ? "set" : "needs key"}
                </td>
                <td>
                  <div className="actions">
                    <button className="ghost" onClick={() => openVm(user)}>
                      VM…
                    </button>
                    <button className="ghost" onClick={() => editName(user)}>
                      Name…
                    </button>
                    <button className="ghost" onClick={() => void changePhoto(user)}>
                      Photo…
                    </button>
                    {user.avatar_updated_at ? (
                      <button className="ghost" onClick={() => clearPhoto(user)}>
                        Remove photo
                      </button>
                    ) : null}
                    <button
                      className="ghost"
                      onClick={() => {
                        const next = window.prompt(
                          `Desktop instance for ${user.email} (host:port, empty to clear)`,
                          user.upstream ?? "",
                        );
                        if (next !== null) {
                          void guard(() => api.updateUser(user.id, { upstream: next.trim() }));
                        }
                      }}
                    >
                      Instance…
                    </button>
                    <button className="ghost" onClick={() => editApiKey(user)}>
                      API key…
                    </button>
                    <button className="ghost" onClick={() => reset(user)}>
                      Reset password
                    </button>
                    <button
                      className="ghost"
                      onClick={() =>
                        guard(() => api.updateUser(user.id, { disabled: !user.disabled }))
                      }
                    >
                      {user.disabled ? "Enable" : "Disable"}
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (window.confirm(`Delete ${user.email}? This cannot be undone.`)) {
                          void guard(() => api.deleteUser(user.id));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
              {vmEditing === user.id ? (
                <tr className="vm-row">
                  <td colSpan={9}>
                    <div className="vm-editor">
                      <label>
                        Memory (GB)
                        <input
                          type="number"
                          min={1}
                          max={16}
                          placeholder="inherit"
                          value={vmMemory}
                          onChange={(event) => setVmMemory(event.target.value)}
                        />
                      </label>
                      <label>
                        vCPU
                        <input
                          type="number"
                          min={1}
                          max={8}
                          placeholder="inherit"
                          value={vmCpu}
                          onChange={(event) => setVmCpu(event.target.value)}
                        />
                      </label>
                      <div className="actions">
                        <button
                          className="ghost"
                          disabled={vmBusy === user.id}
                          onClick={() => void saveVm(user)}
                        >
                          Save
                        </button>
                        <button
                          className="ghost"
                          disabled={vmBusy === user.id || user.disabled > 0 || !user.upstream}
                          onClick={() => void applyVm(user)}
                        >
                          Apply
                        </button>
                        <button
                          className="ghost"
                          disabled={vmBusy === user.id || !user.internal_upstream}
                          onClick={() => void restartVm(user)}
                        >
                          Restart VM
                        </button>
                        <button className="ghost" onClick={() => void pollVmStatus(user)}>
                          Status
                        </button>
                        <button className="ghost" onClick={() => setVmEditing(null)}>
                          Close
                        </button>
                      </div>
                      <p className="muted vm-note">
                        Desired: {vmDesired(user)} · applied: {vmApplied(user)}. Apply recreates
                        the instance (empty fields inherit the deployment); Restart restarts the
                        VM without changing its spec.
                        {vmNote?.id === user.id ? ` ${vmNote.text}` : ""}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>

      <form className="card panel" onSubmit={saveModels}>
        <h2>Model picker</h2>
        <p className="muted" style={{ margin: 0 }}>
          These models sit at the root of the model menu in the composer, in this
          order, for every account — the way the main models sit above "More
          models". Every other configured model moves into that submenu, where it
          is still selectable. Takes effect the next time a page loads.
        </p>
        {catalogue.length > 8 && (
          <label>
            Filter
            <input
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              // Enter belongs to the filter, not to the surrounding form: saving
              // a half-typed search would be a surprise.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="name or id"
            />
          </label>
        )}
        {pickerRows().length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {catalogue.length > 0
              ? "No model matches that filter."
              : catalogueError
                ? `Could not read this instance's model list (${catalogueError}) — add a `
                  + "model by id below, or reload once the app has opened."
                : "This page's instance has not reported its model list yet — open the app "
                  + "once, or add a model by id below."}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pickerRows().map(({ id, name }) => {
              const chosen = mainModels.findIndex(
                (model) => model.toLowerCase() === id.toLowerCase(),
              );
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={chosen >= 0}
                    onChange={() => toggleModel(id)}
                    aria-label={`Keep ${name ?? id} at the root`}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {name ?? id}
                    {name && name !== id ? (
                      <code className="muted" style={{ marginLeft: 8, overflowWrap: "anywhere" }}>
                        {id}
                      </code>
                    ) : null}
                  </span>
                  {chosen >= 0 && (
                    <span className="actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => moveModel(mainModels[chosen], -1)}
                        disabled={chosen === 0}
                        aria-label={`Move ${name ?? id} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => moveModel(mainModels[chosen], 1)}
                        disabled={chosen === mainModels.length - 1}
                        aria-label={`Move ${name ?? id} down`}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {catalogue.length === 0 && (
          <div className="row">
            <label>
              Add a model id
              <input
                value={newModel}
                onChange={(event) => setNewModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addModel();
                }}
                placeholder="claude-opus-5-5"
              />
            </label>
            <div className="actions" style={{ alignItems: "flex-end" }}>
              <button type="button" className="ghost" onClick={addModel} disabled={!newModel.trim()}>
                Add
              </button>
            </div>
          </div>
        )}

        <p className="muted" style={{ margin: 0 }}>
          {mainModels.length === 0
            ? "Nothing pinned — every model stays at the root, which is the default."
            : `${mainModels.length} model${mainModels.length === 1 ? "" : "s"} at the root; `
              + "every other model moves under “More models”."}
        </p>
        <div className="actions">
          <button disabled={busy || !pickerDirty}>{busy ? "Saving…" : "Save picker"}</button>
          {pickerDirty && (
            <button type="button" className="ghost" onClick={() => setMainModels(savedModels)}>
              Discard changes
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
