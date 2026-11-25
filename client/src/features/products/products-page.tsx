import { useAuth } from "../../auth/auth-state";
import { ProductsPanel } from "./products-panel";
import { useParams } from "react-router-dom";

/** Global product list (FR-PRD-09). Supplier-specific lists live on the supplier detail page. */
export function ProductsPage() {
  const { user } = useAuth();
  const { productId } = useParams();
  return <ProductsPanel isAdmin={user?.role === "admin"} initialProductId={productId} />;
}
