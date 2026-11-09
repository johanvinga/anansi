import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/auth-state";
import { PageHeader } from "../../components/page-header";
import { ProductsPanel } from "./products-panel";

/** Global product list (FR-PRD-09). Supplier-specific lists live on the supplier detail page. */
export function ProductsPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("products.title")} breadcrumbs={[{ label: t("products.title") }]} />
      <ProductsPanel isAdmin={user?.role === "admin"} />
    </>
  );
}
