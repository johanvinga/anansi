import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "../../api/client";
import type { CurrentUser } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { PageHeader } from "../../components/page-header";
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
    <>
      <PageHeader title="My account" breadcrumbs={[{ label: "My account" }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-6 py-6">
          <CardHeader className="px-6">
            <CardTitle>
              <h2>Profile</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-6">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-4 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{user.email}</dd>
              <dt className="text-muted-foreground">Display name</dt>
              <dd>{user.displayName ?? "—"}</dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd>
                <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role}</Badge>
              </dd>
              <dt className="text-muted-foreground">Last login</dt>
              <dd>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "—"}</dd>
            </dl>
          </CardContent>
        </Card>
        <ChangePasswordForm onChanged={() => void refreshProfile()} />
      </div>
    </>
  );
}
