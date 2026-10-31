import { Tabs } from "@ark-ui/react/tabs";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { useAuth } from "../auth/auth-state";
import { AccountPage } from "../features/account/account-page";
import { AuditLogPage } from "../features/audit/audit-log-page";
import { CategoriesPage } from "../features/categories/categories-page";
import { SuppliersPage } from "../features/suppliers/suppliers-page";
import { UsersPage } from "../features/users/users-page";

type Section = "suppliers" | "categories" | "users" | "audit" | "account";

export function AppShell() {
  const { user, logout } = useAuth();
  const [section, setSection] = useState<Section>("suppliers");
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const isAdmin = user?.role === "admin";

  if (!user) {
    return null;
  }

  async function handleLogout() {
    setLogoutError(null);
    try {
      await logout();
    } catch (err) {
      setLogoutError(errorMessage(err));
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">Supplier &amp; Product Management</span>
        <span className="app-user">
          {user.displayName ?? user.email} ({user.role})
        </span>
        <button type="button" className="secondary-button" onClick={() => void handleLogout()}>
          Log out
        </button>
      </header>
      {logoutError ? (
        <p role="alert" className="form-error">
          {logoutError}
        </p>
      ) : null}

      <Tabs.Root
        className="tabs"
        value={section}
        onValueChange={(details) => setSection(details.value as Section)}
        lazyMount
        unmountOnExit
      >
        <Tabs.List className="tab-list">
          <Tabs.Trigger value="suppliers">Suppliers</Tabs.Trigger>
          <Tabs.Trigger value="categories">Categories</Tabs.Trigger>
          {isAdmin ? <Tabs.Trigger value="users">Users</Tabs.Trigger> : null}
          {isAdmin ? <Tabs.Trigger value="audit">Audit log</Tabs.Trigger> : null}
          <Tabs.Trigger value="account">My account</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="suppliers">
          <SuppliersPage />
        </Tabs.Content>
        <Tabs.Content value="categories">
          <CategoriesPage />
        </Tabs.Content>
        {isAdmin ? (
          <Tabs.Content value="users">
            <UsersPage />
          </Tabs.Content>
        ) : null}
        {isAdmin ? (
          <Tabs.Content value="audit">
            <AuditLogPage />
          </Tabs.Content>
        ) : null}
        <Tabs.Content value="account">
          <AccountPage />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
