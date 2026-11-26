import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ScanSearch } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { Catalog, ProductDetail } from "../../api/types";
import { loadSettings } from "../../api/settings";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert, SuccessAlert } from "../../components/error-alert";
import { PageHeader } from "../../components/page-header";
import { ProductForm } from "../products/product-form";
import { CatalogExtractionDialog } from "./catalog-extraction-dialog";

export function CatalogWorkspace() {
  const { catalogId = "" } = useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = user?.role === "admin";
  const [sourcePage, setSourcePage] = useState(1);
  const [productOpen, setProductOpen] = useState(false);
  const [createdProduct, setCreatedProduct] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const analysisEnabled = settingsQuery.data?.catalogExtractionEnabled === true;
  const catalogQuery = useQuery({
    queryKey: ["catalog", catalogId],
    queryFn: async () =>
      (await apiRequest<{ catalog: Catalog }>("GET", `/catalogs/${catalogId}`)).catalog,
  });
  const catalog = catalogQuery.data;
  const pdfUrl = `/api/v1/catalogs/${catalogId}/view#page=${sourcePage}`;

  // Going back through history restores the list's search, filters, and page from the URL.
  function goBack() {
    if (location.key === "default") navigate("/catalogs");
    else navigate(-1);
  }

  async function onSaved(product: ProductDetail) {
    setCreatedProduct(localize(product.name));
    setProductOpen(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["suppliers"] }),
      queryClient.invalidateQueries({ queryKey: ["supplier", catalog?.supplierId] }),
    ]);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={catalog?.name ?? t("catalogs.workspaceTitle")}
        breadcrumbs={[
          { label: t("nav.catalogs"), to: "/catalogs" },
          { label: catalog?.name ?? t("catalogs.workspaceTitle") },
        ]}
      />
      <ErrorAlert message={catalogQuery.error ? errorMessage(catalogQuery.error) : null} />
      {!catalog ? null : (
        <Card className="relative flex min-h-[calc(100dvh-13rem)] flex-col gap-0 overflow-hidden py-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={goBack}>
                <ArrowLeft />
                {t("catalogs.back")}
              </Button>
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{catalog.originalFileName}</h2>
                <p className="text-xs text-muted-foreground">{t("catalogs.browserPdfHint")}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {analysisEnabled ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setReviewOpen(true)}>
                  <ScanSearch />
                  {t("catalogs.reviewButton")}
                </Button>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <span className="whitespace-nowrap">{t("catalogs.sourcePage")}</span>
                <Input
                  className="w-20"
                  type="number"
                  min={1}
                  max={100000}
                  value={sourcePage}
                  onChange={(event) =>
                    setSourcePage(Math.max(1, Number.parseInt(event.target.value, 10) || 1))
                  }
                />
              </label>
            </div>
          </div>
          {createdProduct ? (
            <div className="border-b px-4 py-3">
              <SuccessAlert message={t("catalogs.productCreatedInWorkspace", { name: createdProduct })} />
            </div>
          ) : null}
          <iframe
            className="min-h-[65dvh] w-full flex-1 bg-muted"
            src={pdfUrl}
            title={t("catalogs.pdfViewerTitle", { name: catalog.name })}
          />
          {isAdmin ? (
            <Button
              type="button"
              size="lg"
              className="absolute bottom-6 right-6 rounded-full shadow-lg"
              onClick={() => {
                setCreatedProduct(null);
                setProductOpen(true);
              }}
            >
              <Plus />
              {t("products.createProduct")}
            </Button>
          ) : null}
        </Card>
      )}
      {catalog && analysisEnabled && reviewOpen ? (
        <CatalogExtractionDialog
          catalog={catalog}
          isAdmin={isAdmin}
          onClose={() => {
            setReviewOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["catalog", catalogId] });
          }}
        />
      ) : null}
      {catalog && isAdmin && productOpen ? (
        <ProductForm
          defaultSupplierId={catalog.supplierId ?? undefined}
          sourceCatalog={{ catalogId: catalog.id, pageNumbers: [sourcePage] }}
          onClose={() => setProductOpen(false)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}
