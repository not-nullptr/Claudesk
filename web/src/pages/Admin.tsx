import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { User } from "../api";
import { ClaudeSpark } from "../components/ClaudeLogo";
import { ThreedBoxTopIcon, UserDuoIcon } from "blode-icons-react";
import { AdminContext } from "./admin/shared";
import { ModelsPage } from "./admin/ModelsPage";
import { UserPage } from "./admin/UserPage";
import { UsersPage } from "./admin/UsersPage";

/** The three admin surfaces. `/admin` and `/admin/users` are the same page;
 *  a single account is `/admin/users/:id`; the model picker is its own page
 *  under `/admin/models`. */
type Route =
  | { page: "users" }
  | { page: "user"; id: number }
  | { page: "models" };

function routeFor(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/admin";
  if (path === "/admin" || path === "/admin/users") return { page: "users" };
  if (path === "/admin/models") return { page: "models" };
  const match = /^\/admin\/users\/(\d+)$/.exec(path);
  if (match) return { page: "user", id: Number(match[1]) };
  return { page: "users" };
}

/** The admin app: one gate, one shell, and the page the pathname names. */
export function AdminPage() {
  const [me, setMe] = useState<User | null>(null);
  const [path, setPath] = useState(() => window.location.pathname);

  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { user } = await api.me();
        if (user.role !== "Admin") {
          window.location.assign("/");
          return;
        }
        setMe(user);
      } catch {
        window.location.assign("/login");
      }
    })();
  }, []);

  async function logout() {
    await api.logout().catch(() => undefined);
    window.location.assign("/login");
  }

  if (!me) {
    return (
      <div className="admin">
        <div className="admin-splash">
          <ClaudeSpark size={36} className="admin-spark" />
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  const route = routeFor(path);
  const usersActive = route.page === "users" || route.page === "user";
  const modelsActive = route.page === "models";
  const welcome = me.first_name.trim()
    ? `Welcome back, ${me.first_name.trim()}`
    : "Welcome back";

  return (
    <AdminContext.Provider value={{ me, navigate }}>
      <div className="admin">
        <div className="admin-frame">
          <header className="admin-header">
            <div className="admin-lockup">
              <ClaudeSpark size={36} className="admin-spark" />
              <h1 className="admin-welcome">{welcome}</h1>
            </div>
            <button type="button" className="admin-signout" onClick={() => void logout()}>
              Sign out
            </button>
          </header>

          <div className="admin-body">
            <nav className="admin-nav" aria-label="Administration">
              <button
                type="button"
                className="admin-nav-item"
                aria-current={usersActive ? "page" : undefined}
                onClick={() => navigate("/admin/users")}
              >
                <UserDuoIcon size={16} className="admin-nav-icon" />
                Users
              </button>
              <button
                type="button"
                className="admin-nav-item"
                aria-current={modelsActive ? "page" : undefined}
                onClick={() => navigate("/admin/models")}
              >
                <ThreedBoxTopIcon size={16} className="admin-nav-icon" />
                Models
              </button>
            </nav>

            <main className="admin-main">
              {route.page === "users" ? <UsersPage /> : null}
              {route.page === "user" ? <UserPage key={route.id} id={route.id} /> : null}
              {route.page === "models" ? <ModelsPage /> : null}
            </main>
          </div>
        </div>
      </div>
    </AdminContext.Provider>
  );
}
