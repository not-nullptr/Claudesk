import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError, inviteLink } from "../../api";
import type { Role, User } from "../../api";
import { ChevronRightIcon } from "blode-icons-react";
import { InviteNotice, useAdmin, userAccent } from "./shared";

/** The users list: everyone the deployment has an account for, and the one
 *  place a new account is invited. A row opens that person's page. */
export function UsersPage() {
  const { navigate } = useAdmin();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("User");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ label: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { users: next } = await api.listUsers();
      setUsers(next);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load users");
      setUsers((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError("");
    try {
      const { user, invite_token } = await api.createUser(address, role);
      setInvite({ label: user.email, url: inviteLink(invite_token) });
      setEmail("");
      setRole("User");
      setInviteOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not create the account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-list-bar">
        <span className="admin-eyebrow">
          {users === null
            ? "Accounts"
            : `${users.length} account${users.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          className="admin-btn admin-btn--pill"
          aria-expanded={inviteOpen}
          onClick={() => setInviteOpen((open) => !open)}
        >
          {inviteOpen ? "Close" : "Invite someone"}
        </button>
      </div>

      {invite ? (
        <InviteNotice
          label={invite.label}
          url={invite.url}
          onDismiss={() => setInvite(null)}
        />
      ) : null}

      {inviteOpen ? (
        <form className="admin-card admin-invite-form" onSubmit={create}>
          <div className="admin-invite-fields">
            <label className="admin-field">
              <span className="admin-field-label">Email</span>
              <input
                className="admin-input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@example.com"
                autoFocus
                required
              />
            </label>
            <label className="admin-field">
              <span className="admin-field-label">Role</span>
              <select
                className="admin-input admin-select"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                <option value="User">User</option>
                <option value="Admin">Admin</option>
              </select>
            </label>
          </div>
          <div className="admin-form-actions">
            <button className="admin-btn" disabled={busy || !email.trim()}>
              {busy ? "Creating…" : "Create invite"}
            </button>
            <button
              type="button"
              className="admin-text-btn"
              onClick={() => setInviteOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="admin-error" role="alert">
          {error}
        </p>
      ) : null}

      {users === null ? (
        <p className="admin-loading-inline">Loading accounts…</p>
      ) : users.length === 0 ? (
        <p className="admin-empty">No accounts yet — invite the first one.</p>
      ) : (
        <div className="admin-rows">
          {users.map((user) => {
            const name = user.first_name.trim() || user.email;
            return (
              <button
                type="button"
                className="admin-user-row"
                key={user.id}
                onClick={() => navigate(`/admin/users/${user.id}`)}
              >
                <span
                  className={`admin-dot${user.disabled ? " is-disabled" : ""}`}
                  style={{ background: userAccent(user.id) }}
                  aria-hidden="true"
                />
                <span className="admin-row-name">{name}</span>
                <span className="admin-row-tags">
                  {user.disabled ? (
                    <span className="admin-chip admin-chip--warning">Disabled</span>
                  ) : null}
                  {!user.first_name.trim() ? (
                    <span className="admin-chip">Invited</span>
                  ) : null}
                </span>
                {user.first_name.trim() ? (
                  <span className="admin-row-meta">{user.email}</span>
                ) : null}
                <ChevronRightIcon size={18} className="admin-chevron" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
