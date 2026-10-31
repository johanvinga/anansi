import { apiRequest } from "./api/client";
import type { CurrentUser } from "./api/types";
import { useAuth } from "./auth/auth-state";
import { ChangePasswordForm } from "./features/account/change-password-form";
import { LoginPage } from "./features/auth/login-page";
import { AppShell } from "./layout/app-shell";

export function App() {
  const { user, isLoading, logout, setUser } = useAuth();

  if (isLoading) {
    return (
      <main className="auth-page">
        <p role="status">Loading…</p>
      </main>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  if (user.mustChangePassword) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <p role="status">You must choose a new password before continuing.</p>
          <ChangePasswordForm
            onChanged={() =>
              apiRequest<{ user: CurrentUser }>("GET", "/auth/me").then((result) => setUser(result.user))
            }
          />
          <button type="button" className="secondary-button" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </main>
    );
  }

  return <AppShell />;
}
