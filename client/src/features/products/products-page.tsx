import { useAuth } from "../../auth/auth-state";
import { ProductsPanel } from "./products-panel";

/** Global product list (FR-PRD-09). Supplier-specific lists live on the supplier detail page. */
export function ProductsPage() {
  const { user } = useAuth();
  return <ProductsPanel isAdmin={user?.role === "admin"} />;
}
