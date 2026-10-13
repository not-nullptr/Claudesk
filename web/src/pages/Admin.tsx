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
          Invite by email — the person sets their name and photo when they accept.
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
            <th>Status</th>
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
    </div>
  );
}
