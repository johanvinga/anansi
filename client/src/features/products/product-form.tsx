import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "../../components/error-alert";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type {
  AttributeField,
  AttributeValue,
  CatalogProductCandidate,
  ProductDetail,
} from "../../api/types";
import { FormField } from "../../components/form-field";
import { SelectField } from "../../components/select-field";
import { CategoryEditor } from "../suppliers/category-editor";
import { chipsFrom, toCategoryInputs, type CategoryChip } from "../suppliers/category-chips";
import { AttributeInput } from "./attribute-input";
import { useProductFormData } from "./use-product-form-data";

interface ProductFormProps {
  /** When set, the form edits this product; otherwise it creates one. */
  product?: ProductDetail;
  defaultSupplierId?: string;
  defaultAttributeSetId?: string;
  initialProduct?: Pick<CatalogProductCandidate, "name" | "sku" | "description" | "attributes" | "categories">;
  sourceCatalog?: { catalogId: string; pageNumbers: number[] };
  embedded?: boolean;
  onClose: () => void;
  onSaved: (product: ProductDetail) => void;
}

interface ProductDescriptionFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  placeholder?: string;
}

function ProductDescriptionField({ label, value, onChange, error, placeholder }: ProductDescriptionFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        maxLength={2000}
        rows={4}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <FieldError id={hintId}>{error}</FieldError>
      ) : (
        <FieldDescription id={hintId}>{t("products.descriptionLimit")}</FieldDescription>
      )}
    </Field>
  );
}

interface ProductFormSectionProps {
  number: number;
  title: string;
  description: string;
  children: React.ReactNode;
}

function ProductFormSection({ number, title, description, children }: ProductFormSectionProps) {
  return <section className="grid gap-4 border-b py-6 last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{number}</span>
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
    <div className="min-w-0 space-y-4">{children}</div>
  </section>;
}

function initialValues(product: ProductDetail | undefined): Record<string, AttributeValue> {
  const values: Record<string, AttributeValue> = {};
  for (const item of product?.attributeValues ?? []) {
    if (!item.isArchived) values[item.fieldId] = item.value;
  }
  return values;
}

function toSubmitValue(field: AttributeField, value: AttributeValue): AttributeValue {
  if (field.dataType === "boolean") return value === true;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Create or edit a product, including its attribute set values (FR-PRD-01..07). */
export function ProductForm({
  product,
  defaultSupplierId,
  defaultAttributeSetId,
  initialProduct,
  sourceCatalog,
  embedded = false,
  onClose,
  onSaved,
}: ProductFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [supplierId, setSupplierId] = useState<string | null>(product?.supplierId ?? defaultSupplierId ?? null);
  const [nameEn, setNameEn] = useState(product?.name.en ?? initialProduct?.name ?? "");
  const [nameFr, setNameFr] = useState(product?.name.fr ?? initialProduct?.name ?? "");
  const nameFrEdited = Boolean(product);
  const [descriptionEn, setDescriptionEn] = useState(product?.description.en ?? initialProduct?.description ?? "");
  const descriptionFr = product?.description.fr ?? "";
  const [supplierSku, setSupplierSku] = useState(product?.supplierSku ?? initialProduct?.sku ?? "");
  const [minQuantity, setMinQuantity] = useState(product ? product.minQuantity?.toString() ?? "" : "1");
  const [cost, setCost] = useState(product?.cost ?? "");
  const [currency, setCurrency] = useState<string | null>(product?.currency ?? null);
  const [attributeSetId] = useState<string | null>(
    product?.attributeSet?.id ?? defaultAttributeSetId ?? null,
  );
  const [values, setValues] = useState<Record<string, AttributeValue>>(() => initialValues(product));
  const [directValues, setDirectValues] = useState<Record<string, AttributeValue>>(() => initialValues(product));
  const [categories, setCategories] = useState<CategoryChip[]>(
    product
      ? chipsFrom(product.categories)
      : (initialProduct?.categories ?? []).map((name) => ({ name })),
  );
  const candidateValuesApplied = useRef(
    !initialProduct || !defaultAttributeSetId || initialProduct.attributes.length === 0,
  );

  const { currencies, defaultCurrency, suppliers, fields, allFields, fieldsReady, error: dataError } =
    useProductFormData(attributeSetId);
  const independentAttributes = useQuery({
    queryKey: ["independent-attributes"],
    queryFn: async () => (await apiRequest<{ items: AttributeField[] }>("GET", "/attributes")).items,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (candidateValuesApplied.current || fields.length === 0 || !initialProduct) return;
    const normalize = (value: string) => value.trim().toLocaleLowerCase();
    const candidateAttributes = new Map(
      initialProduct.attributes.map((attribute) => [normalize(attribute.name), attribute.value]),
    );
    const extractedValues: Record<string, AttributeValue> = {};
    for (const field of fields) {
      const value = candidateAttributes.get(normalize(field.name.en)) ??
        candidateAttributes.get(normalize(field.name.fr));
      if (value !== undefined) extractedValues[field.id] = value;
    }
    setValues((current) => ({ ...extractedValues, ...current }));
    candidateValuesApplied.current = true;
  }, [fields, initialProduct]);

  const supplierOptions = useMemo(() => {
    const options = suppliers.map((s) => ({ value: s.id, label: s.name }));
    // Keep the current supplier selectable even if it is not in the first page of results.
    if (product && !options.some((o) => o.value === product.supplierId)) {
      options.unshift({ value: product.supplierId, label: product.supplierName });
    }
    return options;
  }, [suppliers, product]);
  const currencyOptions = useMemo(() => currencies.map((c) => ({ value: c, label: c })), [currencies]);

  function changeEnglishName(value: string) {
    setNameEn(value);
    if (!nameFrEdited) setNameFr(value);
  }

  function valueForSetField(field: AttributeField): AttributeValue {
    if (Object.hasOwn(values, field.id)) return values[field.id] ?? null;
    return field.shared ? directValues[field.id] ?? null : null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!supplierId) {
      setError(new ApiError(400, "VALIDATION_ERROR", t("errors.validation"), [{ field: "supplierId", message: t("products.chooseSupplier") }]));
      return;
    }
    if (categories.some((category) => !category.id && category.parentId === undefined)) {
      setError(new ApiError(400, "VALIDATION_ERROR", t("categories.resolveRequired")));
      return;
    }
    const body = {
      name: { en: nameEn, fr: nameFr },
      description: {
        en: descriptionEn.trim() || null,
        fr: descriptionFr.trim() || null,
      },
      supplierSku,
      minQuantity: minQuantity.trim() === "" ? null : Number(minQuantity),
      cost: product ? cost.trim() || null : cost.trim(),
      currency: product ? currency : currency ?? defaultCurrency,
      categories: toCategoryInputs(categories),
      ...(sourceCatalog ? { catalogSource: sourceCatalog } : {}),
      attributeSetId,
      attributeValues: fields.map((field) => ({ fieldId: field.id, value: toSubmitValue(field, valueForSetField(field)) })),
      ...(independentAttributes.data ? {
        directAttributeValues: independentAttributes.data.filter((attribute) => !allFields.some((field) => field.id === attribute.id) && directValues[attribute.id] !== undefined && directValues[attribute.id] !== null).map((attribute) => ({
          fieldId: attribute.id,
          value: toSubmitValue(attribute, directValues[attribute.id] ?? null),
        })),
      } : {}),
    };
    setSubmitting(true);
    try {
      const result = product
        ? await apiRequest<{ product: ProductDetail }>("PUT", `/products/${product.id}`, { ...body, supplierId })
        : await apiRequest<{ product: ProductDetail }>("POST", `/suppliers/${supplierId}/products`, body);
      await queryClient.invalidateQueries({ queryKey: ["categories"] });
      onSaved(result.product);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  const unmatchedErrors = error?.details.filter((d) => !d.field) ?? [];
  const displayedError = error ?? dataError;

  const form = (
    <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      {embedded ? (
        <div className="shrink-0 border-b px-6 py-5">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">{t("products.inventory")}</span>
          <h2 className="mt-1 text-lg font-semibold">{product ? t("products.editAria", { name: localize(product.name) }) : t("products.createProduct")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t(product ? "products.editFormDescription" : "products.createFormDescription")}</p>
        </div>
      ) : (
        <DialogHeader className="shrink-0 flex-col pr-12">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">{t("products.inventory")}</span>
          <DialogTitle>{product ? t("products.editAria", { name: localize(product.name) }) : t("products.createProduct")}</DialogTitle>
          <DialogDescription>{t(product ? "products.editFormDescription" : "products.createFormDescription")}</DialogDescription>
        </DialogHeader>
      )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FieldGroup className="gap-0 px-1">
              {displayedError && (displayedError.details.length === 0 || unmatchedErrors.length > 0) ? (
                <ErrorAlert message={displayedError.message} />
              ) : null}
              <ErrorAlert message={error?.fieldError("attributeValues")} />
              <ErrorAlert message={independentAttributes.error ? errorMessage(independentAttributes.error) : null} />

              <ProductFormSection number={1} title={t("products.detailsSubtitle")} description={t("products.detailsSectionDescription")}>
                <FormField
                  label={t("products.nameEn")}
                  value={nameEn}
                  onChange={changeEnglishName}
                  required
                  maxLength={200}
                  placeholder={t("products.namePlaceholder")}
                  error={error?.fieldError("name.en")}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <SelectField
                    label={t("products.supplier")}
                    options={supplierOptions}
                    value={supplierId}
                    onChange={setSupplierId}
                    required
                    disabled={!product && Boolean(defaultSupplierId)}
                    error={error?.fieldError("supplierId")}
                    placeholder={t("products.supplierPlaceholder")}
                  />
                  <FormField label={t("products.supplierSku")} value={supplierSku} onChange={setSupplierSku} required placeholder={t("products.skuPlaceholder")} error={error?.fieldError("supplierSku")} />
                </div>
                <ProductDescriptionField
                  label={t("products.descriptionEn")}
                  value={descriptionEn}
                  onChange={setDescriptionEn}
                  placeholder={t("products.descriptionPlaceholder")}
                  error={error?.fieldError("description.en")}
                />
                <FieldSet>
                  <FieldLegend>{t("categories.title")}</FieldLegend>
                  <CategoryEditor value={categories} onChange={setCategories} maxCategories={100} />
                  {error?.fieldError("categories") ? <FieldError>{error.fieldError("categories")}</FieldError> : null}
                </FieldSet>
              </ProductFormSection>
              <ProductFormSection number={2} title={t("products.purchasingTitle")} description={t("products.purchasingDescription")}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <FormField
                    label={t("products.costLabel")}
                    value={cost}
                    onChange={setCost}
                    placeholder="0.00"
                    required={!product}
                    helperText={t("products.decimals2")}
                    error={error?.fieldError("cost")}
                  />
                  <SelectField
                    label={t("products.currency")}
                    options={product ? [{ value: "", label: t("attributeSets.noneOption") }, ...currencyOptions] : currencyOptions}
                    value={product ? currency : currency ?? defaultCurrency}
                    onChange={(value) => setCurrency(value || null)}
                    required={!product}
                    error={error?.fieldError("currency")}
                  />
                  <FormField
                    label={t("products.minimumQuantity")}
                    type="number"
                    value={minQuantity}
                    onChange={setMinQuantity}
                    required={!product}
                    helperText={t("products.minimumQuantityHint")}
                    error={error?.fieldError("minQuantity")}
                  />
                </div>
              </ProductFormSection>
              <ProductFormSection number={3} title={t("products.specificationsTitle")} description={t("products.specificationsDescription")}>
                {independentAttributes.data && independentAttributes.data.length > 0 ? (
                  <FieldSet>
                    <FieldLegend>{t("attributes.title")}</FieldLegend>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      {independentAttributes.data.filter((attribute) => !allFields.some((field) => field.id === attribute.id)).map((attribute) => (
                        <AttributeInput
                          key={attribute.id}
                          field={attribute}
                          value={directValues[attribute.id] ?? null}
                          onChange={(value) => setDirectValues((current) => ({ ...current, [attribute.id]: value }))}
                          error={error?.fieldError(`attributeValues.${attribute.id}`)}
                        />
                      ))}
                    </div>
                  </FieldSet>
                ) : null}
              </ProductFormSection>
              </FieldGroup>
            </div>
      {embedded ? (
        <div className="mt-0 flex shrink-0 flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          <p className="mr-auto basis-full text-xs text-muted-foreground sm:basis-auto"><span className="text-destructive">*</span> {t("products.requiredFields")}</p>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={submitting || !fieldsReady || independentAttributes.isLoading || Boolean(independentAttributes.error)}>
            {submitting ? t("common.saving") : product ? t("products.saveProduct") : t("products.createProduct")}
          </Button>
        </div>
      ) : (
        <DialogFooter className="mt-0 shrink-0 flex-row flex-wrap items-center">
              <p className="mr-auto basis-full text-xs text-muted-foreground sm:basis-auto"><span className="text-destructive">*</span> {t("products.requiredFields")}</p>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("common.cancel")}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={submitting || !fieldsReady || independentAttributes.isLoading || Boolean(independentAttributes.error)}>
                {submitting ? t("common.saving") : product ? t("products.saveProduct") : t("products.createProduct")}
              </Button>
        </DialogFooter>
      )}
    </form>
  );

  if (embedded) {
    return <section className="flex min-h-0 flex-1 flex-col">{form}</section>;
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="flex max-h-[95dvh] flex-col overflow-hidden sm:max-w-5xl">
        {form}
      </DialogContent>
    </Dialog>
  );
}
