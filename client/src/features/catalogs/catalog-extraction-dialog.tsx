import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { apiRequest, errorMessage } from "../../api/client";
import type {
  Catalog,
  CatalogAnalysisStatus,
  CatalogExtraction,
  CatalogSupplierReview,
  CatalogTagReview,
} from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";

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
  const [notice, setNotice] = useState<string | null>(null);
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
  const supplierReviewQuery = useQuery({
    queryKey: ["catalog-supplier-review", catalog.id, job?.jobId],
    queryFn: () => apiRequest<CatalogSupplierReview>("GET", `/catalogs/${catalog.id}/extraction/${job!.jobId}/supplier-review`),
    enabled: Boolean(job?.status === "processed" && job.prompt === "supplier"),
  });
  const tagReviewQuery = useQuery({
    queryKey: ["catalog-tag-review", catalog.id, job?.jobId],
    queryFn: () => apiRequest<CatalogTagReview>("GET", `/catalogs/${catalog.id}/extraction/${job!.jobId}/tag-review`),
    enabled: Boolean(job?.status === "processed" && job.prompt === "tags"),
  });
  const canRetry =
    isAdmin &&
    extraction !== undefined &&
    (extraction.analysisStatus === "not_processed" ||
      extraction.analysisStatus === "failed" ||
      extraction.analysisStatus === "metadata_only" ||
      extraction.analysisStatus === "processed" ||
      extraction.analysisStatus === "queued");

  async function runPrompt(prompt: "supplier" | "tags") {
    setError(null);
    setRetrying(true);
    try {
      await apiRequest("POST", `/catalogs/${catalog.id}/extraction`, { prompt });
      await extractionQuery.refetch();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  }

  async function applySupplierReview(review: CatalogSupplierReview) {
    if (!review.supplier?.name) {
      setError("No supplier name was found by the analysis.");
      return;
    }
    setError(null);
    try {
      await apiRequest("POST", `/catalogs/${catalog.id}/extraction/supplier-review`, {
        jobId: review.jobId,
        action: review.exactMatch ? "reuse" : "create",
        supplierId: review.exactMatch?.id,
        name: review.supplier.name.value,
        address: {
          street: review.supplier.address.street?.value ?? null,
          city: review.supplier.address.city?.value ?? null,
          stateRegion: review.supplier.address.stateRegion?.value ?? null,
          postalCode: review.supplier.address.postalCode?.value ?? null,
          country: review.supplier.address.country?.value ?? null,
        },
        website: review.supplier.website?.value ?? null,
        contacts: (review.supplier.contacts ?? []).map((contact) => ({
          name: contact.name.value,
          role: contact.role?.value ?? null,
        })),
      });
      await Promise.all([
        extractionQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["catalogs"] }),
        queryClient.invalidateQueries({ queryKey: ["suppliers"] }),
      ]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function applyTagReview(review: CatalogTagReview) {
    setError(null);
    setNotice(null);
    // Catalog tags are the union of catalog-level tags and every product tag, deduplicated by English name.
    const catalogTagMap = new Map<string, (typeof review.catalogTags)[number]>();
    for (const tag of [...(review.catalogTags ?? []), ...(review.products ?? []).flatMap((product) => product.tags ?? [])]) {
      if (tag?.name?.en) catalogTagMap.set(tag.name.en.trim().toLowerCase(), tag);
    }
    const catalogTags = [...catalogTagMap.values()];
    if (catalogTags.length === 0) {
      setError("The analysis found no tags to apply. Run Deduct product tags again.");
      return;
    }
    try {
      await apiRequest("POST", `/catalogs/${catalog.id}/extraction/tag-review`, {
        jobId: review.jobId,
        catalogTagIds: catalogTags.flatMap((tag) => tag.existing ? [tag.existing.id] : []),
        newCatalogTags: catalogTags.flatMap((tag) => tag.existing ? [] : [{ en: tag.name.en, fr: tag.name.fr }]),
        productTagIds: review.products.flatMap((product) =>
          product.existingProduct
            ? [{
                productId: product.existingProduct.id,
                tagIds: product.tags.flatMap((tag) => tag.existing ? [tag.existing.id] : []),
                newTags: product.tags.flatMap((tag) => tag.existing ? [] : [{ en: tag.name.en, fr: tag.name.fr }]),
              }]
            : [],
        ),
      });
      await Promise.all([
        extractionQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["catalogs"] }),
        queryClient.invalidateQueries({ queryKey: ["suppliers"] }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        tagReviewQuery.refetch(),
      ]);
      setNotice(`Applied ${catalogTags.length} tag(s) to this catalog.`);
    } catch (err) {
      setError(errorMessage(err));
    }
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
            {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
            <ErrorAlert
              message={
                error ??
                (extractionQuery.error
                  ? errorMessage(extractionQuery.error)
                  : supplierReviewQuery.error
                    ? errorMessage(supplierReviewQuery.error)
                    : tagReviewQuery.error
                      ? errorMessage(tagReviewQuery.error)
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

                  {supplierReviewQuery.data?.supplier ? (
                    <section className="flex flex-col gap-3 rounded-lg border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="font-semibold">Supplier metadata review</h3>
                        {isAdmin ? (
                          <Button type="button" onClick={() => void applySupplierReview(supplierReviewQuery.data!)}>
                            {supplierReviewQuery.data!.exactMatch ? "Reuse exact supplier" : "Create confirmed supplier"}
                          </Button>
                        ) : null}
                      </div>
                      <dl className="grid gap-2 text-sm sm:grid-cols-2">
                        {[
                          ["Name", supplierReviewQuery.data.supplier.name],
                          ["Street", supplierReviewQuery.data.supplier.address.street],
                          ["City", supplierReviewQuery.data.supplier.address.city],
                          ["State/region", supplierReviewQuery.data.supplier.address.stateRegion],
                          ["Postal code", supplierReviewQuery.data.supplier.address.postalCode],
                          ["Country", supplierReviewQuery.data.supplier.address.country],
                          ["Website", supplierReviewQuery.data.supplier.website],
                          ["Email", supplierReviewQuery.data.supplier.email],
                          ["Phone", supplierReviewQuery.data.supplier.phone],
                        ].map(([label, evidence]) => evidence && typeof evidence === "object" && "value" in evidence ? (
                          <div key={label as string}>
                            <dt className="font-medium">{label as string}</dt>
                            <dd>{(evidence as { value: string; pageNumber: number; excerpt: string }).value}</dd>
                            <dd className="text-xs text-muted-foreground">
                              Page {(evidence as { value: string; pageNumber: number; excerpt: string }).pageNumber}: {(evidence as { value: string; pageNumber: number; excerpt: string }).excerpt}
                            </dd>
                          </div>
                        ) : null)}
                      </dl>
                    </section>
                  ) : null}

                  {job?.prompt === "supplier" && job.results ? (
                    <details className="rounded-lg border p-4 text-sm">
                      <summary className="cursor-pointer font-medium">Gemini Prompt A response</summary>
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                        {JSON.stringify(job.results, null, 2)}
                      </pre>
                    </details>
                  ) : null}

                  {tagReviewQuery.data ? (
                    <section className="flex flex-col gap-3 rounded-lg border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="font-semibold">Catalog tag review</h3>
                        {isAdmin ? (
                          <Button type="button" onClick={() => void applyTagReview(tagReviewQuery.data!)}>
                            Apply confirmed tags
                          </Button>
                        ) : null}
                      </div>
                      {(tagReviewQuery.data.catalogTags ?? []).filter((tag) => tag?.name).map((tag) => (
                        <div key={`${tag.name.en}-${tag.name.fr}`} className="rounded border p-3 text-sm">
                          <p className="font-medium">{tag.name.en} / {tag.name.fr}</p>
                          <p className="text-muted-foreground">
                            {tag.existing ? "Existing tag: reuse" : "New tag: create"} · confidence {Math.round(tag.confidence * 100)}%
                          </p>
                          {(tag.evidence ?? []).map((item) => (
                            <p key={`${item.pageNumber}-${item.excerpt}`} className="text-xs text-muted-foreground">
                              Page {item.pageNumber}: {item.excerpt}
                            </p>
                          ))}
                        </div>
                      ))}
                      {(tagReviewQuery.data.products ?? []).map((product) => (
                        <div key={product.name} className="rounded border p-3 text-sm">
                          <p className="font-medium">{product.name}</p>
                          <div className="flex flex-wrap gap-1">
                            {(product.tags ?? []).filter((tag) => tag?.name).map((tag) => (
                              <Badge key={`${tag.name.en}-${tag.name.fr}`} variant="outline">
                                {tag.name.en}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </section>
                  ) : null}
                </div>
                {canRetry ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => void runPrompt("supplier")} disabled={retrying}>
                      {retrying ? t("catalogs.retryingAnalysis") : "Extract supplier metadata"}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void runPrompt("tags")} disabled={retrying}>
                      {retrying ? t("catalogs.retryingAnalysis") : "Deduct product tags"}
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}


          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


    </>
  );
}

