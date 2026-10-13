import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, inviteLink, Role, User } from "../api";

export function AdminPage() {
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ label: string; url: string } | null>(null);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [role, setRole] = useState<Role>("User");
  const [upstream, setUpstream] = useState("");

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
      const { user, invite_token } = await api.createUser(
        email.trim(),
        firstName.trim(),
        role,
        upstream.trim(),
      );
      setInvite({ label: user.email, url: inviteLink(invite_token) });
      setEmail("");
      setFirstName("");
      setRole("User");
      setUpstream("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not create the account");
    }
    setBusy(false);
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
            First name
            <input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
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
          <label>
            Instance upstream
            <input
              placeholder="127.0.0.1:15901"
              value={upstream}
              onChange={(event) => setUpstream(event.target.value)}
            />
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
              <td>{user.first_name}</td>
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
