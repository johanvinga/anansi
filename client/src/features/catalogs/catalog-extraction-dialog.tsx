import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { apiRequest, errorMessage } from "../../api/client";
import type {
  Catalog,
  CatalogAnalysisStatus,
  CatalogExtraction,
  CatalogProductCandidate,
  ProductDetail,
} from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { ProductForm } from "../products/product-form";

interface CatalogExtractionDialogProps {
  catalog: Catalog;
  isAdmin: boolean;
  onClose: () => void;
}

function analysisStatusLabel(status: CatalogAnalysisStatus, t: (key: string) => string): string {
  return t(`catalogs.analysisStatus.${status}`);
}

export function CatalogExtractionDialog({ catalog, isAdmin, onClose }: CatalogExtractionDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState<CatalogProductCandidate | null>(null);
  const [creatingAttributeSet, setCreatingAttributeSet] = useState(false);
  const [attributeSetId, setAttributeSetId] = useState<string | undefined>();
  const [createdProductName, setCreatedProductName] = useState<string | null>(null);
  const extractionQuery = useQuery({
    queryKey: ["catalog-extraction", catalog.id],
    queryFn: () => apiRequest<CatalogExtraction>("GET", `/catalogs/${catalog.id}/extraction`),
    refetchInterval: (query) =>
      query.state.data?.analysisStatus === "queued" || query.state.data?.analysisStatus === "processing"
        ? 1500
        : false,
  });
  const extraction = extractionQuery.data;
  const job = extraction?.job;
  const results = job?.results;
  const candidateCategories = [...new Set(results?.products.flatMap((product) => product.categories ?? []) ?? [])];
  const suggestedAttributeSetName =
    candidateCategories.length === 1 ? candidateCategories[0]! : `${catalog.name} attributes`.slice(0, 100);
  const canRetry =
    isAdmin &&
    extraction !== undefined &&
    (extraction.analysisStatus === "not_processed" ||
      extraction.analysisStatus === "failed" ||
      extraction.analysisStatus === "processed");

  async function retryAnalysis() {
    setError(null);
    setRetrying(true);
    try {
      await apiRequest("POST", `/catalogs/${catalog.id}/extraction`);
      await extractionQuery.refetch();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  }

  function onProductCreated(product: ProductDetail) {
    setCreatingProduct(null);
    setCreatedProductName(product.name.en);
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    void queryClient.invalidateQueries({ queryKey: ["supplier", catalog.supplierId] });
    void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("catalogs.reviewTitle", { name: catalog.name })}</DialogTitle>
            <DialogDescription>{t("catalogs.reviewDescription")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-5">
            <ErrorAlert
              message={
                error ??
                (extractionQuery.error
                  ? errorMessage(extractionQuery.error)
                  : job?.error ?? null)
              }
            />

            {extraction ? (
              <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant={extraction.analysisStatus === "failed" ? "destructive" : "secondary"}>
                    {analysisStatusLabel(extraction.analysisStatus, t)}
                  </Badge>
                  {job ? (
                    <span className="text-sm text-muted-foreground">
                      {t("catalogs.analysisProgress", {
                        progress: job.progress,
                        current: job.currentPage,
                        total: job.totalPages,
                        stage: job.stage,
                      })}
                    </span>
                  ) : null}
                </div>
                {canRetry ? (
                  <Button type="button" variant="outline" onClick={() => void retryAnalysis()} disabled={retrying}>
                    {retrying ? t("catalogs.retryingAnalysis") : t("catalogs.retryAnalysis")}
                  </Button>
                ) : null}
              </section>
            ) : null}

            {results ? (
              <>
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-semibold">{t("catalogs.productCandidates", { count: results.products.length })}</h3>
                    <span className="text-sm text-muted-foreground">
                      {t("catalogs.reviewBeforeImport")}
                    </span>
                  </div>
                  {results.products.length === 0 ? (
                    <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                      {t("catalogs.noProductCandidates")}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {results.products.map((candidate, index) => (
                        <li key={`${candidate.sku ?? candidate.name}-${index}`} className="flex flex-col gap-3 rounded-lg border p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <h4 className="font-medium">{candidate.name}</h4>
                              <p className="text-sm text-muted-foreground">
                                {t("catalogs.candidateSku")}: {candidate.sku ?? "—"} · {t("catalogs.sourcePages")}: {candidate.source.pageNumbers.join(", ")}
                              </p>
                              {(candidate.categories ?? []).length > 0 ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {(candidate.categories ?? []).map((category) => (
                                    <Badge key={category} variant="outline">{category}</Badge>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            {isAdmin ? (
                              <Button type="button" size="sm" onClick={() => setCreatingProduct(candidate)}>
                                {t("catalogs.createProductFromCandidate")}
                              </Button>
                            ) : null}
                          </div>
                          {candidate.description ? (
                            <p className="text-sm">{candidate.description}</p>
                          ) : null}
                          {candidate.attributes.length > 0 ? (
                            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                              {candidate.attributes.map((attribute, attributeIndex) => (
                                <div key={`${attribute.name}-${attributeIndex}`} className="flex gap-2">
                                  <dt className="font-medium">{attribute.name}:</dt>
                                  <dd>{attribute.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                          <div className="text-sm">
                            <p className="mb-2 text-muted-foreground">{t("catalogs.sourceExcerpt")}</p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-sans">
                              {candidate.source.excerpt}
                            </pre>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {results.suggestedAttributeFields.length > 0 ? (
                  <section className="flex flex-col gap-3 rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">{t("catalogs.suggestedAttributes")}</h3>
                        <p className="text-sm text-muted-foreground">{t("catalogs.suggestedAttributesDescription")}</p>
                      </div>
                      {isAdmin ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setCreatingAttributeSet(true)}
                          disabled={attributeSetId !== undefined}
                        >
                          {attributeSetId ? t("catalogs.attributeSetCreated") : t("catalogs.createAttributeSet")}
                        </Button>
                      ) : null}
                    </div>
                    <ul className="flex flex-wrap gap-2">
                      {results.suggestedAttributeFields.map((field) => (
                        <li key={field.name}>
                          <Badge variant="outline">{field.name}</Badge>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {results.pages.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("catalogs.pageSources")}:{" "}
                    {results.pages.map((page) => `${page.pageNumber} (${page.textSource === "ocr" ? t("catalogs.ocr") : t("catalogs.selectableText")})`).join(", ")}
                  </p>
                ) : null}
              </>
            ) : null}

            {createdProductName ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("catalogs.productCreated", { name: createdProductName })}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {creatingAttributeSet && results ? (
        <CreateSuggestedAttributeSetDialog
          defaultName={suggestedAttributeSetName}
          fieldNames={results.suggestedAttributeFields.map((field) => field.name)}
          onClose={() => setCreatingAttributeSet(false)}
          onCreated={(id) => {
            setAttributeSetId(id);
            setCreatingAttributeSet(false);
            void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
          }}
        />
      ) : null}

      {creatingProduct ? (
        <ProductForm
          defaultSupplierId={catalog.supplierId ?? undefined}
          defaultAttributeSetId={attributeSetId}
          initialProduct={creatingProduct}
          onClose={() => setCreatingProduct(null)}
          onSaved={onProductCreated}
        />
      ) : null}
    </>
  );
}

interface CreateSuggestedAttributeSetDialogProps {
  defaultName: string;
  fieldNames: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}

function CreateSuggestedAttributeSetDialog({
  defaultName,
  fieldNames,
  onClose,
  onCreated,
}: CreateSuggestedAttributeSetDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await apiRequest<{ attributeSet: { id: string } }>("POST", "/attribute-sets", {
        name: { en: name.trim(), fr: name.trim() },
        fields: fieldNames.map((fieldName) => ({
          name: { en: fieldName, fr: fieldName },
          dataType: "text",
          unit: null,
          isRequired: false,
        })),
      });
      onCreated(result.attributeSet.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t("catalogs.createAttributeSet")}</DialogTitle>
            <DialogDescription>{t("catalogs.createAttributeSetDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error} />
            <FormField
              label={t("attributeSets.name")}
              value={name}
              onChange={setName}
              maxLength={100}
              required
            />
            <p className="text-sm text-muted-foreground">
              {t("catalogs.fieldsToCreate", { fields: fieldNames.join(", ") })}
            </p>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? t("common.saving") : t("catalogs.createAttributeSet")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
