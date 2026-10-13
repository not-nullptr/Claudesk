import { FormEvent, useState } from "react";
import { api, ApiError, browserTimezone } from "../api";

export function AcceptInvitePage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setError("this invite link is missing its token");
      return;
    }
    if (password !== confirm) {
      setError("the passwords do not match");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // The user's own browser is here for the first time — this is where their
      // timezone is captured.
      const { user } = await api.acceptInvite(token, password, browserTimezone());
      window.location.assign(user.role === "Admin" ? "/admin" : "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not set your password");
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <form className="card" onSubmit={submit}>
        <h1>Set your password</h1>
        <p className="muted" style={{ margin: 0 }}>
          Welcome to Claudesk. Choose a password to activate your account.
        </p>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button disabled={busy}>{busy ? "Saving…" : "Set password and continue"}</button>
      </form>
    </div>
  );
}
