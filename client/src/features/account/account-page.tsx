import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "../../api/client";
import type { CurrentUser } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { PageHeader } from "../../components/page-header";
import { ChangePasswordForm } from "./change-password-form";

export function AccountPage() {
  const { user, setUser } = useAuth();
  const { t } = useTranslation();
  if (!user) {
    return null;
  }

  async function refreshProfile() {
    const result = await apiRequest<{ user: CurrentUser }>("GET", "/auth/me");
    setUser(result.user);
  }

  const title = t("account.title");

  return (
    <>
      <PageHeader title={title} breadcrumbs={[{ label: title }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-6 py-6">
          <CardHeader className="px-6">
            <CardTitle>
              <h2>{t("account.profile")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-6">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-4 text-sm">
              <dt className="text-muted-foreground">{t("account.email")}</dt>
              <dd>{user.email}</dd>
              <dt className="text-muted-foreground">{t("account.name")}</dt>
              <dd>{user.displayName ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("account.role")}</dt>
              <dd>
                <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                  {user.role === "admin" ? t("account.roleAdmin") : t("account.roleStandard")}
                </Badge>
              </dd>
            </dl>
          </CardContent>
        </Card>
        <ChangePasswordForm onChanged={() => void refreshProfile()} />
      </div>
    </>
  );
}
