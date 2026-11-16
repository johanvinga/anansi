import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import { loadSettings } from "../../api/settings";
import type { AttributeField, Category } from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { CheckboxField } from "../../components/checkbox-field";
import { FormField } from "../../components/form-field";
import { SelectField } from "../../components/select-field";
import { loadCatalogSuppliers } from "./supplier-picker";

interface Preview {
  supplierId: string | null;
  products: {
    index: number;
    name: string;
    sku: string | null;
    duplicateExisting: boolean;
    duplicateInSelection: boolean;
    categories: { name: string; matches: string[] }[];
    attributeNames: string[];
    attributeValues: { name: string; value: string }[];
  }[];
  attributes: {
    name: string;
    examples: string[];
    status: "reuse" | "review" | "create";
    candidates: { id: string; name: string; dataType: string; unit: string | null; set: { id: string; name: string } | null }[];
  }[];
  categoryTree: { version: string; categories: Category[] };
}

interface CategoryDecision {
  version: string;
  choice: string;
  parent: string | null;
}

interface CatalogImportPreviewDialogProps {
  catalogId: string;
  jobId: string;
  indexes: number[];
  onClose: () => void;
  onSupplierAssigned: (supplierId: string) => void;
}

export function CatalogImportPreviewDialog({ catalogId, jobId, indexes, onClose, onSupplierAssigned }: CatalogImportPreviewDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<number, { sku: string; cost: string; currency: string; minQuantity: string }>>({});
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [categoryDecisions, setCategoryDecisions] = useState<Record<number, Record<string, CategoryDecision>>>({});
  const [extraCategories, setExtraCategories] = useState<Record<number, { version: string; ids: string[] }>>({});
  const [reviewed, setReviewed] = useState<Record<number, Record<string, { attributeId: string; value: string | boolean }>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [assigningSupplier, setAssigningSupplier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ created: string[]; skipped: number[] } | null>(null);
  const independent = useQuery({
    queryKey: ["independent-attributes"],
    queryFn: async () => (await apiRequest<{ items: AttributeField[] }>("GET", "/attributes")).items,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const query = useQuery({
    queryKey: ["catalog-import-preview", catalogId, jobId, indexes],
    queryFn: () => apiRequest<Preview>("POST", `/catalogs/${catalogId}/extraction/preview`, { jobId, indexes }),
    retry: false,
    staleTime: 0,
  });
  const preview = query.data;
  const suppliers = useQuery({
    queryKey: ["suppliers", "catalog-picker"],
    queryFn: loadCatalogSuppliers,
    enabled: Boolean(preview && !preview.supplierId),
  });
  async function assignSupplier() {
    setError(null);
    if (!supplierId) {
      setError(t("catalogs.previewSupplierMissing"));
      return;
    }
    setAssigningSupplier(true);
    try {
      await apiRequest("PATCH", `/catalogs/${catalogId}`, { supplierId });
      onSupplierAssigned(supplierId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["catalogs"] }),
        queryClient.invalidateQueries({ queryKey: ["suppliers"] }),
        queryClient.invalidateQueries({ queryKey: ["supplier"] }),
        queryClient.invalidateQueries({ queryKey: ["catalog-extraction", catalogId] }),
      ]);
      const refreshed = await query.refetch();
      if (refreshed.isError) throw refreshed.error;
    } catch (err) {
      setError(err instanceof ApiError && err.details.length ? err.details.map((detail) => detail.message).join(" ") : errorMessage(err));
    } finally {
      setAssigningSupplier(false);
    }
  }
  const seenSkus = new Set<string>();
  const skipped = new Set<number>();
  for (const product of preview?.products ?? []) {
    const sku = (values[product.index]?.sku ?? product.sku ?? "").trim().toLowerCase();
    const originalSku = (product.sku ?? "").trim().toLowerCase();
    if (sku && ((product.duplicateExisting && sku === originalSku) || seenSkus.has(sku))) {
      skipped.add(product.index);
    }
    if (sku) seenSkus.add(sku);
  }
  const activeProducts = (preview?.products ?? []).filter((product) => !skipped.has(product.index));
  const categoryOptions = (preview?.categoryTree.categories ?? []).map((category) => ({
    value: category.id, label: category.path.map((part) => localize(part.name)).join(" / "),
  }));
  function categoryDecision(index: number, suggestion: { name: string; matches: string[] }): CategoryDecision {
    const saved = categoryDecisions[index]?.[suggestion.name];
    if (saved?.version === preview?.categoryTree.version) return saved;
    return { version: preview?.categoryTree.version ?? "", choice: suggestion.matches.length === 1 ? suggestion.matches[0]! : "", parent: null };
  }
  function updateCategory(index: number, name: string, decision: CategoryDecision) {
    setCategoryDecisions((current) => ({ ...current, [index]: { ...current[index], [name]: decision } }));
  }
  const neededNames = new Set(activeProducts.flatMap((product) => product.attributeNames));
  const neededAttributes = (preview?.attributes ?? []).filter((attribute) => neededNames.has(attribute.name));
  const normalizeName = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
  function exactIndependent(name: string) {
    return (independent.data ?? []).filter((field) =>
      [field.name.en, field.name.fr].some((translation) => normalizeName(translation) === normalizeName(name)));
  }
  function automaticMapping(name: string) {
    const exact = exactIndependent(name);
    return exact.length === 1 && exact[0]!.dataType === "text" && exact[0]!.unit === null
      ? exact[0]!.id
      : "__skip__";
  }
  const effectiveMappings = Object.fromEntries(neededAttributes.map((attribute) => {
    return [attribute.name, mappings[attribute.name] ?? automaticMapping(attribute.name)];
  }));
  const unmatchedAttributes = neededAttributes.filter((attribute) => automaticMapping(attribute.name) === "__skip__");
  const matchedAttributes = neededAttributes.filter((attribute) => automaticMapping(attribute.name) !== "__skip__");
  const reviewItems = activeProducts.flatMap((product) => product.attributeValues.flatMap((attribute) => {
    const field = independent.data?.find((item) => item.id === effectiveMappings[attribute.name]);
    return field && (field.dataType !== "text" || field.unit !== null) ? [{ product, attribute, field }] : [];
  }));
  const conflictingProducts = activeProducts.filter((product) => {
    const ids = product.attributeNames.map((name) => effectiveMappings[name]).filter((id) => id && id !== "__create__" && id !== "__skip__");
    return new Set(ids).size !== ids.length;
  });
  async function submit() {
    setError(null);
    if (!preview?.supplierId) {
      setError(t("catalogs.previewSupplierMissing"));
      return;
    }
    setSubmitting(true);
    try {
      if (activeProducts.some((product) => !product.name.trim() || !(values[product.index]?.sku ?? product.sku ?? "").trim())) {
        throw new Error(t("catalogs.importMissingValues"));
      }
      if (activeProducts.some((product) => product.categories.some((suggestion) => {
        const decision = categoryDecision(product.index, suggestion);
        return !decision.choice || (decision.choice === "__create__" && decision.parent === null);
      }))) throw new Error(t("catalogs.importCategoryMissing"));
      if (conflictingProducts.length) throw new Error(t("catalogs.importMappingConflict"));
      if (reviewItems.some(({ product, attribute, field }) => {
        const answer = reviewed[product.index]?.[attribute.name];
        return !answer || answer.attributeId !== field.id || (typeof answer.value === "string" && !answer.value.trim());
      })) throw new Error(t("catalogs.importTypedMissing"));
      const response = await apiRequest<{ created: string[]; skipped: number[] }>(
        "POST", `/catalogs/${catalogId}/extraction/import`, {
          jobId, supplierId: preview.supplierId,
          products: preview.products.map((product) => ({
            index: product.index,
            sku: values[product.index]?.sku ?? product.sku ?? "",
            ...(skipped.has(product.index) ? {} : {
              ...(values[product.index]?.cost.trim() ? { cost: values[product.index]!.cost.trim() } : {}),
              ...(values[product.index]?.currency ? { currency: values[product.index]!.currency } : {}),
              ...(values[product.index]?.minQuantity.trim() ? { minQuantity: Number(values[product.index]!.minQuantity) } : {}),
              categoryDecisions: product.categories.map((suggestion) => {
                const decision = categoryDecision(product.index, suggestion);
                return decision.choice === "__create__"
                  ? { name: suggestion.name, action: "create", parentId: decision.parent === "__root__" ? null : decision.parent }
                  : { name: suggestion.name, action: "reuse", categoryId: decision.choice };
              }),
              additionalCategoryIds: extraCategories[product.index]?.version === preview.categoryTree.version ? extraCategories[product.index]!.ids : [],
              attributeValues: reviewItems.filter((item) => item.product.index === product.index).map(({ attribute }) => ({
                name: attribute.name, value: reviewed[product.index]![attribute.name]!.value,
              })),
            }),
          })),
          mappings: neededAttributes.map((attribute) => ({
            name: attribute.name,
            attributeId: effectiveMappings[attribute.name] === "__create__" || effectiveMappings[attribute.name] === "__skip__"
              ? null : effectiveMappings[attribute.name],
            ...(effectiveMappings[attribute.name] === "__skip__" ? { skip: true } : {}),
          })),
          categoryTreeVersion: preview.categoryTree.version,
        },
      );
      setOutcome(response);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["suppliers"] }),
        queryClient.invalidateQueries({ queryKey: ["independent-attributes"] }),
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
      ]);
    } catch (err) {
      setError(err instanceof ApiError && err.details.length ? err.details.map((detail) => detail.message).join(" ") : errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }
  function change(index: number, field: "sku" | "cost" | "currency" | "minQuantity", value: string, sku: string | null) {
    setValues((current) => ({ ...current, [index]: {
      sku: current[index]?.sku ?? sku ?? "", cost: current[index]?.cost ?? "",
      currency: current[index]?.currency ?? "", minQuantity: current[index]?.minQuantity ?? "",
      [field]: value,
    } }));
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("catalogs.previewTitle")}</DialogTitle>
          <DialogDescription>{t("catalogs.previewDescription")}</DialogDescription>
        </DialogHeader>
        {query.isLoading ? <p>{t("common.loading")}</p> : null}
        {query.isFetching && preview ? <p role="status">{t("catalogs.importRefreshingPreview")}</p> : null}
        <ErrorAlert message={error ?? (query.error ? errorMessage(query.error) : independent.error ? errorMessage(independent.error) : settings.error ? errorMessage(settings.error) : !preview?.supplierId && suppliers.error ? errorMessage(suppliers.error) : null)} />
        {independent.isLoading ? <p role="status">{t("catalogs.importAttributesLoading")}</p> : null}
        {independent.isError ? <Button type="button" variant="outline" onClick={() => void independent.refetch()}>{t("catalogs.importRetryAttributes")}</Button> : null}
        {settings.isError ? <Button type="button" variant="outline" onClick={() => void settings.refetch()}>{t("catalogs.importRetrySettings")}</Button> : null}
        {query.isError ? <Button type="button" variant="outline" onClick={() => { setError(null); void query.refetch(); }}>{t("catalogs.importRetryPreview")}</Button> : null}
        {error && preview && !query.isError ? <Button type="button" variant="outline" onClick={() => { setError(null); void query.refetch(); }}>{t("catalogs.importRetryPreview")}</Button> : null}
        {outcome ? <p role="status">{t("catalogs.importResult", { created: outcome.created.length, skipped: outcome.skipped.length })}</p> : null}
        {preview ? (
          <div className="flex flex-col gap-4 text-sm">
            <p>{t("catalogs.previewProductCount", { count: preview.products.length })}</p>
            <p>{t("catalogs.importDecisionSummary", {
              products: activeProducts.length,
              reused: new Set(neededAttributes.map((attribute) => effectiveMappings[attribute.name]).filter((id) => id && id !== "__create__" && id !== "__skip__")).size,
              created: neededAttributes.filter((attribute) => effectiveMappings[attribute.name] === "__create__").length,
              skipped: neededAttributes.filter((attribute) => effectiveMappings[attribute.name] === "__skip__").length,
            })}</p>
            {neededAttributes.some((attribute) => effectiveMappings[attribute.name] === "__create__") ? (
              <p className="font-medium">{t("catalogs.importNewWarning")}</p>
            ) : null}
            {conflictingProducts.length ? <p className="font-medium">{t("catalogs.importMappingConflict")}</p> : null}
            {!preview.supplierId ? (
              <section className="flex flex-col gap-3 rounded border p-3">
                <p className="font-medium">{t("catalogs.previewSupplierMissing")}</p>
                <SelectField label={t("catalogs.supplier")} value={supplierId} onChange={setSupplierId}
                  disabled={!suppliers.data || assigningSupplier}
                  options={(suppliers.data ?? []).map((supplier) => ({ value: supplier.id, label: supplier.name }))} />
                {suppliers.isLoading ? <p role="status">{t("common.loading")}</p> : null}
                {suppliers.isError ? <Button type="button" variant="outline" onClick={() => void suppliers.refetch()}>{t("catalogs.importRetrySuppliers")}</Button> : null}
                {suppliers.isSuccess && suppliers.data.length === 0 ? <p>{t("catalogs.importNoSuppliers")}</p> : null}
                <Button type="button" variant="outline" className="self-start" disabled={!supplierId || assigningSupplier || query.isFetching || query.isError || !suppliers.data?.some((supplier) => supplier.id === supplierId)}
                  onClick={() => void assignSupplier()}>
                  {assigningSupplier ? t("common.saving") : t("catalogs.importAssignSupplier")}
                </Button>
              </section>
            ) : null}
            <section>
              <h3 className="font-semibold">{t("catalogs.importUnmatchedTitle")}</h3>
              <p>{t("catalogs.importUnmatchedDescription")}</p>
              {unmatchedAttributes.length === 0 ? <p>{t("catalogs.importNoUnmatched")}</p> : null}
              <ul className="mt-2 flex flex-col gap-2">
                {unmatchedAttributes.map((attribute) => (
                  <li key={attribute.name} className="rounded border p-3">
                    <p className="font-medium">{attribute.name}</p>
                    <p>{t("catalogs.previewExamples")}: {[...new Set(activeProducts.flatMap((product) =>
                      product.attributeValues.filter((value) => value.name === attribute.name).map((value) => value.value)))].slice(0, 3).join(", ")}</p>
                    {attribute.candidates.map((candidate) => (
                      <p key={candidate.id}>{candidate.name}{candidate.set ? ` · ${candidate.set.name}` : ""} · {candidate.dataType}{candidate.unit ? ` · ${candidate.unit}` : ""}</p>
                    ))}
                    <CheckboxField
                      label={t("catalogs.importCreateAttribute", { name: attribute.name })}
                      checked={effectiveMappings[attribute.name] === "__create__"}
                      disabled={(independent.data ?? []).some((field) => normalizeName(field.name.en) === normalizeName(attribute.name))}
                      onChange={(checked) => setMappings((current) => ({ ...current, [attribute.name]: checked ? "__create__" : "__skip__" }))}
                    />
                    {(independent.data ?? []).some((field) => normalizeName(field.name.en) === normalizeName(attribute.name)) ? <p>{t("catalogs.importExistingName")}</p> : null}
                    <SelectField
                      label={t("catalogs.importMapping")}
                      value={effectiveMappings[attribute.name] === "__create__" ? null : effectiveMappings[attribute.name]}
                      placeholder={t("catalogs.importChooseExisting")}
                      onChange={(value) => setMappings((current) => ({ ...current, [attribute.name]: value ?? "__skip__" }))}
                      options={[
                        { value: "__skip__", label: t("catalogs.importSkipAttribute") },
                        ...(independent.data ?? []).map((item) => ({ value: item.id, label: `${t("catalogs.importReuseAttribute", { name: localize(item.name) })} · ${item.dataType}${item.unit ? ` (${item.unit})` : ""}` })),
                      ]}
                    />
                  </li>
                ))}
              </ul>
            </section>
            {matchedAttributes.length ? <section>
              <h3 className="font-semibold">{t("catalogs.importMatchedTitle")}</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {matchedAttributes.map((attribute) => <li key={attribute.name} className="rounded border p-3">
                  <p className="font-medium">{attribute.name}</p>
                  <p>{t("catalogs.previewExamples")}: {[...new Set(activeProducts.flatMap((product) =>
                    product.attributeValues.filter((value) => value.name === attribute.name).map((value) => value.value)))].slice(0, 3).join(", ")}</p>
                  <SelectField label={t("catalogs.importMapping")} value={effectiveMappings[attribute.name]}
                    onChange={(value) => setMappings((current) => ({ ...current, [attribute.name]: value ?? "__skip__" }))}
                    options={[
                      { value: "__skip__", label: t("catalogs.importSkipAttribute") },
                      ...(independent.data ?? []).map((item) => ({ value: item.id, label: `${t("catalogs.importReuseAttribute", { name: localize(item.name) })} · ${item.dataType}${item.unit ? ` (${item.unit})` : ""}` })),
                    ]} />
                </li>)}
              </ul>
            </section> : null}
            <section>
              <h3 className="font-semibold">{t("catalogs.previewProducts")}</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {preview.products.map((product) => (
                  <li key={product.index} className="rounded border p-3">
                    <p className="font-medium">{product.name} · {product.sku ?? "—"}</p>
                    <p>{t("catalogs.previewMissing")}: {!(values[product.index]?.sku ?? product.sku ?? "").trim() ? t("catalogs.previewField.sku") : "—"}</p>
                    {product.duplicateExisting ? <p>{t("catalogs.previewDuplicateExisting")}</p> : null}
                    {product.duplicateInSelection ? <p>{t("catalogs.previewDuplicateSelection")}</p> : null}
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <FormField label={t("catalogs.previewField.sku")} value={values[product.index]?.sku ?? product.sku ?? ""} onChange={(v) => change(product.index, "sku", v, product.sku)} required />
                      {!skipped.has(product.index) ? (
                        <>
                        <FormField label={t("catalogs.previewField.cost")} value={values[product.index]?.cost ?? ""} onChange={(v) => change(product.index, "cost", v, product.sku)} />
                        <SelectField label={t("catalogs.previewField.currency")} value={values[product.index]?.currency ?? ""}
                          onChange={(value) => change(product.index, "currency", value ?? "", product.sku)}
                          options={[{ value: "", label: t("attributeSets.noneOption") }, ...(settings.data?.currencies ?? []).map((currency) => ({ value: currency, label: currency }))]}
                          disabled={!settings.data} />
                        <FormField label={t("catalogs.previewField.minQuantity")} type="number" value={values[product.index]?.minQuantity ?? ""} onChange={(v) => change(product.index, "minQuantity", v, product.sku)} />
                        </>
                      ) : null}
                    </div>
                    {!skipped.has(product.index) ? <div className="mt-3 flex flex-col gap-3">
                      <h4 className="font-semibold">{t("catalogs.importCategories")}</h4>
                      {product.categories.length === 0 ? <p>{t("catalogs.importNoCategorySuggestion")}</p> : null}
                      {product.categories.map((suggestion) => {
                        const decision = categoryDecision(product.index, suggestion);
                        return <div key={suggestion.name} className="flex flex-col gap-2 rounded border p-3">
                          <p>{t("catalogs.importCategorySuggestion", { name: suggestion.name })}</p>
                          <SelectField label={t("catalogs.importCategoryChoice")} value={decision.choice || null}
                            onChange={(value) => updateCategory(product.index, suggestion.name, { ...decision, choice: value ?? "", parent: null })}
                            options={[...categoryOptions, { value: "__create__", label: t("catalogs.importCategoryCreate", { name: suggestion.name }) }]} required />
                          {decision.choice === "__create__" ? <>
                            <p>{t("catalogs.importCategoryCreateWarning")}</p>
                            <SelectField label={t("catalogs.importCategoryParent")} value={decision.parent}
                              onChange={(value) => updateCategory(product.index, suggestion.name, { ...decision, parent: value })}
                              options={[{ value: "__root__", label: t("catalogs.importCategoryRoot") }, ...categoryOptions]} required />
                          </> : null}
                        </div>;
                      })}
                      <SelectField label={t("catalogs.importCategoryAdd")} value={null}
                        onChange={(value) => {
                          if (!value) return;
                          setExtraCategories((current) => {
                            const previous = current[product.index];
                            const ids = previous?.version === preview.categoryTree.version ? previous.ids : [];
                            return { ...current, [product.index]: { version: preview.categoryTree.version, ids: [...new Set([...ids, value])] } };
                          });
                        }} options={categoryOptions.filter((option) => !(extraCategories[product.index]?.version === preview.categoryTree.version && extraCategories[product.index]?.ids.includes(option.value)))} />
                      {(extraCategories[product.index]?.version === preview.categoryTree.version ? extraCategories[product.index]!.ids : []).map((id) =>
                        <div key={id} className="flex items-center justify-between gap-2">
                          <span>{categoryOptions.find((option) => option.value === id)?.label}</span>
                          <Button type="button" variant="outline" onClick={() => setExtraCategories((current) => ({
                            ...current, [product.index]: { version: preview.categoryTree.version, ids: (current[product.index]?.ids ?? []).filter((item) => item !== id) },
                          }))}>{t("catalogs.importCategoryRemove")}</Button>
                        </div>)}
                    </div> : null}
                  </li>
                ))}
              </ul>
            </section>
            {reviewItems.length ? (
              <section className="flex flex-col gap-3">
                <h3 className="font-semibold">{t("catalogs.importTypedTitle")}</h3>
                <p>{t("catalogs.importTypedDescription")}</p>
                {reviewItems.map(({ product, attribute, field }, index) => {
                  const answer = reviewed[product.index]?.[attribute.name];
                  const value = answer?.attributeId === field.id ? answer.value : undefined;
                  const setValue = (next: string | boolean) => setReviewed((current) => ({
                    ...current, [product.index]: { ...current[product.index], [attribute.name]: { attributeId: field.id, value: next } },
                  }));
                  const label = `${product.name} · ${localize(field.name)}${field.unit ? ` (${field.unit})` : ""}`;
                  return <div key={`${product.index}-${attribute.name}-${index}`} className="rounded border p-3">
                    <p>{t("catalogs.importExtractedValue")}: {attribute.value}</p>
                    {field.dataType === "boolean" ? (
                      <SelectField label={label} value={typeof value === "boolean" ? String(value) : null}
                        onChange={(next) => { if (next === "true" || next === "false") setValue(next === "true"); }}
                        options={[{ value: "true", label: t("catalogs.importYes") }, { value: "false", label: t("catalogs.importNo") }]} required />
                    ) : field.dataType === "select" ? (
                      <SelectField label={label} value={typeof value === "string" ? value : null}
                        onChange={(next) => setValue(next ?? "")}
                        options={field.options.map((option) => ({ value: option.id, label: localize(option.label) }))} required />
                    ) : (
                      <FormField label={label} type={field.dataType === "date" ? "date" : "text"}
                        value={typeof value === "string" ? value : ""} onChange={setValue} required />
                    )}
                  </div>;
                })}
              </section>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>
          {preview && !outcome ? <Button type="button" disabled={!preview.supplierId || assigningSupplier || submitting || !independent.data || independent.isError || !settings.data || settings.isError || query.isError || query.isFetching} onClick={() => void submit()}>
            {submitting ? t("common.saving") : t("catalogs.importConfirm")}
          </Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
