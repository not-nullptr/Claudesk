import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AcceptInvitePage } from "./pages/AcceptInvite";
import { AdminPage } from "./pages/Admin";
import { LoginPage } from "./pages/Login";

// One bundle, three routes. The server serves this document for any non-API
// path, so routing here is just reading the pathname.
function App() {
  const { pathname } = window.location;
  if (pathname.startsWith("/accept-invite")) return <AcceptInvitePage />;
  if (pathname.startsWith("/admin")) return <AdminPage />;
  return <LoginPage />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
