import { useAuth } from "../../auth/auth-state";
import { PageHeader } from "../../components/page-header";
import { ProductsPanel } from "./products-panel";

/** Global product list (FR-PRD-09). Supplier-specific lists live on the supplier detail page. */
export function ProductsPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="Products" breadcrumbs={[{ label: "Products" }]} />
      <ProductsPanel isAdmin={user?.role === "admin"} />
    </>
  );
}
