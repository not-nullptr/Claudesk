import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { ClaudeLogo } from "../components/ClaudeLogo";

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
    <main className="auth">
      <div className="auth__logo">
        <ClaudeLogo />
      </div>
      <div className="auth__inner">
        <div className="auth__column">
          <h1 className="auth__title">Sign in</h1>
          <p className="auth__subtitle">Continue with your Claudesk account.</p>
          <form className="auth-card" onSubmit={submit}>
            <input
              type="email"
              autoComplete="username"
              aria-label="Email"
              placeholder="Enter your email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
            <input
              type="password"
              autoComplete="current-password"
              aria-label="Password"
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error && (
              <p className="auth__error" role="alert">
                {error}
              </p>
            )}
            <button className="auth-submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
