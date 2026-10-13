import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, browserTimezone, prepareAvatar } from "../api";
import { ClaudeLogo } from "../components/ClaudeLogo";

export function AcceptInvitePage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [firstName, setFirstName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!photo) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setError("this invite link is missing its token");
      return;
    }
    if (!firstName.trim()) {
      setError("please tell us your first name");
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
      // name and timezone are captured, and the only place they set them.
      const { user } = await api.acceptInvite(
        token,
        password,
        browserTimezone(),
        firstName.trim(),
      );
      if (photo) {
        // The invite is already spent, so a photo that fails to upload must not
        // block activating the account; the admin can set one later.
        try {
          await api.uploadAvatar(await prepareAvatar(photo));
        } catch (err) {
          console.warn("avatar upload failed", err);
        }
      }
      window.location.assign(user.role === "Admin" ? "/admin" : "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not set your password");
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
          <h1 className="auth__title">Set up your account</h1>
          <p className="auth__subtitle">
            Welcome to Claudesk. Tell us who you are and choose a password to activate
            your account.
          </p>
          <form className="auth-card" onSubmit={submit}>
            <input
              type="text"
              autoComplete="given-name"
              aria-label="First name"
              placeholder="First name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
              autoFocus
            />
            <input
              type="file"
              aria-label="Profile photo (optional)"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
            />
            {preview && <img className="avatar preview" src={preview} alt="Profile preview" />}
            <input
              type="password"
              autoComplete="new-password"
              aria-label="Password"
              placeholder="Choose a password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <input
              type="password"
              autoComplete="new-password"
              aria-label="Confirm password"
              placeholder="Confirm password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
            {error && (
              <p className="auth__error" role="alert">
                {error}
              </p>
            )}
            <button className="auth-submit" disabled={busy}>
              {busy ? "Saving…" : "Set up and continue"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
