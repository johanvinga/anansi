import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { Catalog, ProductDetail } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert, SuccessAlert } from "../../components/error-alert";
import { PageHeader } from "../../components/page-header";
import { ProductForm } from "../products/product-form";

export function CatalogWorkspace() {
  const { catalogId = "" } = useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === "admin";
  const [sourcePage, setSourcePage] = useState(1);
  const [formKey, setFormKey] = useState(0);
  const [createdProduct, setCreatedProduct] = useState<string | null>(null);
  const catalogQuery = useQuery({
    queryKey: ["catalog", catalogId],
    queryFn: async () =>
      (await apiRequest<{ catalog: Catalog }>("GET", `/catalogs/${catalogId}`)).catalog,
  });
  const catalog = catalogQuery.data;
  const pdfUrl = `/api/v1/catalogs/${catalogId}/view#page=${sourcePage}`;

  async function onSaved(product: ProductDetail) {
    setCreatedProduct(localize(product.name));
    setFormKey((key) => key + 1);
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
        actions={
          catalog ? (
            <Button variant="outline" asChild>
              <a href={`/api/v1/catalogs/${catalog.id}/view`} target="_blank" rel="noreferrer">
                <ExternalLink />
                {t("catalogs.openPdfInNewTab")}
              </a>
            </Button>
          ) : null
        }
      />
      <ErrorAlert message={catalogQuery.error ? errorMessage(catalogQuery.error) : null} />
      {!catalog ? null : (
        <div className="grid min-h-[calc(100dvh-13rem)] gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(420px,0.9fr)]">
          <Card className="flex min-h-[70dvh] flex-col gap-0 overflow-hidden py-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{catalog.originalFileName}</h2>
                <p className="text-xs text-muted-foreground">{t("catalogs.browserPdfHint")}</p>
              </div>
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
            <iframe
              className="min-h-[65dvh] w-full flex-1 bg-muted"
              src={pdfUrl}
              title={t("catalogs.pdfViewerTitle", { name: catalog.name })}
            />
          </Card>

          <Card className="flex min-h-[70dvh] min-w-0 flex-col gap-0 overflow-hidden py-0">
            {isAdmin ? (
              <>
                <div className="border-b px-6 py-3">
                  {createdProduct ? (
                    <>
                      <SuccessAlert message={t("catalogs.productCreatedInWorkspace", { name: createdProduct })} />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          setCreatedProduct(null);
                          setFormKey((key) => key + 1);
                        }}
                      >
                        <RotateCcw />
                        {t("catalogs.resetProductForm")}
                      </Button>
                    </>
                  ) : null}
                </div>
                <ProductForm
                  key={formKey}
                  embedded
                  defaultSupplierId={catalog.supplierId ?? undefined}
                  sourceCatalog={{ catalogId: catalog.id, pageNumbers: [sourcePage] }}
                  onClose={() => setFormKey((key) => key + 1)}
                  onSaved={onSaved}
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
                {t("catalogs.workspaceReadOnly")}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
