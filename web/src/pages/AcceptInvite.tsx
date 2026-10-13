import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, browserTimezone, prepareAvatar } from "../api";

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
    <div className="shell">
      <form className="card" onSubmit={submit}>
        <h1>Set up your account</h1>
        <p className="muted" style={{ margin: 0 }}>
          Welcome to Claudesk. Tell us who you are and choose a password to activate
          your account.
        </p>
        <label>
          First name
          <input
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Profile photo <span className="muted">(optional)</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
          />
        </label>
        {preview && <img className="avatar preview" src={preview} alt="Profile preview" />}
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
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
        <button disabled={busy}>{busy ? "Saving…" : "Set up and continue"}</button>
      </form>
    </div>
  );
}
