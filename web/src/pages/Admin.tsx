import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, avatarUrl, inviteLink, prepareAvatar, Role, User } from "../api";

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
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [newModel, setNewModel] = useState("");

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
    // Only a convenience: a gateway that discovers its models serves no list, and
    // this origin may not reach a bridge at all. Neither is an error.
    try {
      setSuggestions(await api.configuredModels());
    } catch {
      setSuggestions([]);
    }
  }

  /** Every model id the card can show: the chosen ones first, in their order. */
  function pickerRows(): string[] {
    const rows = [...mainModels];
    for (const id of suggestions) {
      if (!rows.some((chosen) => chosen.toLowerCase() === id.toLowerCase())) rows.push(id);
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
            <th>API key</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
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
                {user.api_key_updated_at ? "set" : "needs key"}
              </td>
              <td>
                <div className="actions">
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
        {pickerRows().length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            This deployment reports no configured models to list. Add one by id below.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pickerRows().map((id) => {
              const chosen = mainModels.findIndex(
                (model) => model.toLowerCase() === id.toLowerCase(),
              );
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={chosen >= 0}
                    onChange={() => toggleModel(id)}
                    aria-label={`Keep ${id} at the root`}
                  />
                  <code style={{ flex: 1, overflowWrap: "anywhere" }}>{id}</code>
                  {chosen >= 0 && (
                    <span className="actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => moveModel(mainModels[chosen], -1)}
                        disabled={chosen === 0}
                        aria-label={`Move ${id} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => moveModel(mainModels[chosen], 1)}
                        disabled={chosen === mainModels.length - 1}
                        aria-label={`Move ${id} down`}
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
