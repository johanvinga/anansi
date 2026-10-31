import { apiRequest } from "../../api/client";
import type { CurrentUser } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ChangePasswordForm } from "./change-password-form";

export function AccountPage() {
  const { user, setUser } = useAuth();
  if (!user) {
    return null;
  }

  async function refreshProfile() {
    const result = await apiRequest<{ user: CurrentUser }>("GET", "/auth/me");
    setUser(result.user);
  }

  return (
    <section className="page">
      <h1>My account</h1>
      <dl className="card profile">
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Display name</dt>
        <dd>{user.displayName ?? "—"}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Last login</dt>
        <dd>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "—"}</dd>
      </dl>
      <ChangePasswordForm onChanged={() => void refreshProfile()} />
    </section>
  );
}
