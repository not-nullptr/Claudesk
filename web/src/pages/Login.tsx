import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user } = await api.login(email.trim(), password);
      // Admins land on user management; everyone else goes to their workspace.
      window.location.assign(user.role === "Admin" ? "/admin" : "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "sign in failed");
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <form className="card" onSubmit={submit}>
        <h1>Sign in</h1>
        <p className="muted" style={{ margin: 0 }}>
          Claudesk
        </p>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
