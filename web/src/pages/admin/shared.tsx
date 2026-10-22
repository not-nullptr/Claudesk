import { createContext, useContext, useState } from "react";
import { AlertCircleIcon } from "blode-icons-react";
import type { CSSProperties } from "react";
import type { User } from "../../api";

/** What every admin page gets from the shell: the signed-in admin, and the
 *  history-backed navigator shared by the sidebar and the list rows. */
export interface AdminContextValue {
  me: User;
  navigate: (to: string) => void;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin was called outside the admin shell");
  return value;
}

/** The accents list rows and photo placeholders draw from. They are the
 *  ground-truth tokens, not literals: each keeps its light/dark pair. */
const ACCENTS = [
  "var(--admin-accent-brand)",
  "var(--admin-accent-200)",
  "var(--admin-danger-200)",
  "var(--admin-success-200)",
  "var(--admin-accent-pro-200)",
  "var(--admin-warning-000)",
];

export function userAccent(id: number): string {
  return ACCENTS[Math.abs(id - 1) % ACCENTS.length];
}

/** CSS custom property for elements that tint themselves from the account's
 *  accent (the photo placeholder's wash and initial). */
export function accentStyle(id: number): CSSProperties {
  return { "--admin-user-accent": userAccent(id) } as CSSProperties;
}

export function formatDate(unix: number | null | undefined): string {
  if (!unix) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(unix * 1000));
  } catch {
    return "—";
  }
}

/** Open the OS file picker and resolve with the chosen image, or null. */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** The one-time invite link, shown after an account is created or its password
 *  is reset. The URL is selectable and copyable; dismissing forgets it. */
export function InviteNotice({
  label,
  url,
  onDismiss,
}: {
  label: string;
  url: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permission is the browser's call; the URL stays selectable.
    }
  }

  return (
    <div className="admin-invite" role="note">
      <span className="admin-field-label">Invite link for {label} — shown once</span>
      <code className="admin-invite-url">{url}</code>
      <div className="admin-invite-actions">
        <button type="button" className="admin-btn admin-btn--small" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" className="admin-text-btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** The floating bar panel.fig pins under the single-user page: a change is
 *  pending, and this is the one control that commits it. Both admin pages use
 *  it, so it lives here. */
export function PendingBar({
  text,
  action,
  busyLabel,
  busy,
  onAction,
  onDiscard,
}: {
  text: string;
  action: string;
  busyLabel: string;
  busy: boolean;
  onAction: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="admin-bar" role="status" aria-live="polite">
      <AlertCircleIcon size={20} className="admin-bar-icon" />
      <span className="admin-bar-text">{text}</span>
      {onDiscard ? (
        <button
          type="button"
          className="admin-bar-discard"
          onClick={onDiscard}
          disabled={busy}
        >
          Discard
        </button>
      ) : null}
      <button
        type="button"
        className="admin-bar-action"
        onClick={onAction}
        disabled={busy}
      >
        {busy ? busyLabel : action}
      </button>
    </div>
  );
}
