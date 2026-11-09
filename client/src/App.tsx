import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { apiRequest } from "./api/client";
import type { CurrentUser } from "./api/types";
import { useAuth } from "./auth/auth-state";
import { CatalogsPage } from "./features/catalogs/catalogs-page";
import { AccountPage } from "./features/account/account-page";
import { ChangePasswordForm } from "./features/account/change-password-form";
import { AttributeSetsPage, AttributeSetBuilderPage } from "./features/attribute-sets/attribute-sets-page";
import { AuditLogPage } from "./features/audit/audit-log-page";
import { LoginPage } from "./features/auth/login-page";
import { CategoriesPage } from "./features/categories/categories-page";
import { ProductsPage } from "./features/products/products-page";
import { SupplierDetailPage, SupplierNewPage, SuppliersPage } from "./features/suppliers/suppliers-page";
import { UsersPage } from "./features/users/users-page";
import { AppShell } from "./layout/app-shell";

export function App() {
  const { t } = useTranslation();
  const { user, isLoading, logout, setUser } = useAuth();
  const location = useLocation();
  const isAdmin = user?.role === "admin";

  if (isLoading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("common.loading")}
        </p>
      </main>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" state={{ from: location.pathname }} replace />} />
      </Routes>
    );
  }

  if (user.mustChangePassword) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-md gap-6 py-6">
          <CardHeader className="px-6">
            <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Boxes className="size-5" />
            </div>
            <CardTitle className="text-lg">{t("account.chooseNewPassword")}</CardTitle>
            <CardDescription role="status">{t("account.mustChoosePassword")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-6">
            <ChangePasswordForm
              embedded
              onChanged={() =>
                apiRequest<{ user: CurrentUser }>("GET", "/auth/me").then((result) => setUser(result.user))
              }
            />
            <Button variant="outline" size="lg" onClick={() => void logout()}>
              {t("common.signOut")}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/suppliers" replace />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/suppliers" replace />} />
        <Route path="suppliers" element={<SuppliersPage />} />
        {isAdmin ? <Route path="suppliers/new" element={<SupplierNewPage />} /> : null}
        <Route path="suppliers/:supplierId" element={<SupplierDetailPage />} />
        <Route path="suppliers/:supplierId/:tab" element={<SupplierDetailPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="catalogs" element={<CatalogsPage />} />
        <Route path="attribute-sets" element={<AttributeSetsPage />} />
        <Route path="attribute-sets/:attributeSetId" element={<AttributeSetBuilderPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        {isAdmin ? <Route path="users" element={<UsersPage />} /> : null}
        {isAdmin ? <Route path="audit" element={<AuditLogPage />} /> : null}
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/suppliers" replace />} />
      </Route>
    </Routes>
  );
}
