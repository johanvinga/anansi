import { useTranslation } from "react-i18next";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
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
  FieldSeparator,
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
import { ConfirmDialog } from "../../components/confirm-dialog";
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
  onClose: () => void;
  onSaved: (product: ProductDetail) => void;
}

interface ProductDescriptionFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}

function ProductDescriptionField({ label, value, onChange, error }: ProductDescriptionFieldProps) {
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
  onClose,
  onSaved,
}: ProductFormProps) {
  const { t } = useTranslation();
  const [supplierId, setSupplierId] = useState<string | null>(product?.supplierId ?? defaultSupplierId ?? null);
  const [nameEn, setNameEn] = useState(product?.name.en ?? initialProduct?.name ?? "");
  const [nameFr, setNameFr] = useState(product?.name.fr ?? initialProduct?.name ?? "");
  const [nameFrEdited, setNameFrEdited] = useState(Boolean(product));
  const [descriptionEn, setDescriptionEn] = useState(product?.description.en ?? initialProduct?.description ?? "");
  const [descriptionFr, setDescriptionFr] = useState(product?.description.fr ?? "");
  const [supplierSku, setSupplierSku] = useState(product?.supplierSku ?? initialProduct?.sku ?? "");
  const [minQuantity, setMinQuantity] = useState(product ? String(product.minQuantity) : "1");
  const [cost, setCost] = useState(product?.cost ?? "");
  const [currency, setCurrency] = useState<string | null>(product?.currency ?? null);
  const [attributeSetId, setAttributeSetId] = useState<string | null>(
    product?.attributeSet?.id ?? defaultAttributeSetId ?? null,
  );
  const [values, setValues] = useState<Record<string, AttributeValue>>(() => initialValues(product));
  const [categories, setCategories] = useState<CategoryChip[]>(
    product
      ? chipsFrom(product.categories)
      : (initialProduct?.categories ?? []).map((name) => ({ name })),
  );
  const [pendingSetId, setPendingSetId] = useState<string | null | undefined>(undefined);
  const candidateValuesApplied = useRef(
    !initialProduct || !defaultAttributeSetId || initialProduct.attributes.length === 0,
  );

  const { currencies, defaultCurrency, suppliers, sets, fields, error: dataError } =
    useProductFormData(attributeSetId);
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
  const setOptions = useMemo(() => [{ value: "", label: t("attributeSets.noneOption") }, ...sets.map((s) => ({ value: s.id, label: localize(s.name) }))], [sets, t]);

  function changeEnglishName(value: string) {
    setNameEn(value);
    if (!nameFrEdited) setNameFr(value);
  }

  function requestSetChange(next: string | null) {
    const normalized = next || null;
    if (normalized === attributeSetId) return;
    const hasValues = Object.values(values).some((v) => v !== null && v !== "" && v !== false);
    // Changing the set removes values for fields that are not in the new set (FR-PRD-07, FR-UI-04).
    if (hasValues || (product && product.attributeValues.length > 0 && normalized !== product.attributeSet?.id)) {
      setPendingSetId(normalized);
    } else {
      applySetChange(normalized);
    }
  }

  function applySetChange(next: string | null) {
    setAttributeSetId(next);
    setValues({});
    setPendingSetId(undefined);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!supplierId) {
      setError(new ApiError(400, "VALIDATION_ERROR", t("errors.validation"), [{ field: "supplierId", message: t("products.chooseSupplier") }]));
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
      cost: cost.trim(),
      currency: currency ?? defaultCurrency,
      categories: toCategoryInputs(categories),
      attributeSetId,
      attributeValues: fields.map((field) => ({ fieldId: field.id, value: toSubmitValue(field, values[field.id] ?? null) })),
    };
    setSubmitting(true);
    try {
      const result = product
        ? await apiRequest<{ product: ProductDetail }>("PUT", `/products/${product.id}`, { ...body, supplierId })
        : await apiRequest<{ product: ProductDetail }>("POST", `/suppliers/${supplierId}/products`, body);
      onSaved(result.product);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  const archivedValues = product?.attributeValues.filter((v) => v.isArchived && v.fieldId) ?? [];
  const unmatchedErrors = error?.details.filter((d) => !d.field) ?? [];
  const displayedError = error ?? dataError;

  return (
    <>
      <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>{product ? t("products.editAria", { name: localize(product.name) }) : t("products.createProduct")}</DialogTitle>
            </DialogHeader>
            <FieldGroup>
              {displayedError && (displayedError.details.length === 0 || unmatchedErrors.length > 0) ? (
                <ErrorAlert message={displayedError.message} />
              ) : null}
              <ErrorAlert message={error?.fieldError("attributeValues")} />

              <SelectField
                label={t("products.supplier")}
                options={supplierOptions}
                value={supplierId}
                onChange={setSupplierId}
                required
                disabled={!product && Boolean(defaultSupplierId)}
                error={error?.fieldError("supplierId")}
              />
              <FieldSet>
                <FieldLegend>{t("categories.title")}</FieldLegend>
                <CategoryEditor value={categories} onChange={setCategories} />
                {error?.fieldError("categories") ? <FieldError>{error.fieldError("categories")}</FieldError> : null}
              </FieldSet>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  label={t("products.nameEn")}
                  value={nameEn}
                  onChange={changeEnglishName}
                  required
                  maxLength={200}
                  error={error?.fieldError("name.en")}
                />
                <FormField
                  label={t("products.nameFr")}
                  value={nameFr}
                  onChange={(value) => {
                    setNameFr(value);
                    setNameFrEdited(true);
                  }}
                  required
                  maxLength={200}
                  error={error?.fieldError("name.fr")}
                />
                <FormField label={t("products.supplierSku")} value={supplierSku} onChange={setSupplierSku} required error={error?.fieldError("supplierSku")} />
                <FormField
                  label={t("products.minimumQuantity")}
                  type="number"
                  value={minQuantity}
                  onChange={setMinQuantity}
                  required
                  error={error?.fieldError("minQuantity")}
                />
                <FormField
                  label={t("products.costLabel")}
                  value={cost}
                  onChange={setCost}
                  required
                  helperText={t("products.decimals2")}
                  error={error?.fieldError("cost")}
                />
                <SelectField
                  label={t("products.currency")}
                  options={currencyOptions}
                  value={currency ?? defaultCurrency}
                  onChange={setCurrency}
                  required
                  error={error?.fieldError("currency")}
                />
              </div>

              <FieldSet>
                <FieldLegend>{t("products.productDescription")}</FieldLegend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ProductDescriptionField
                    label={t("products.descriptionEn")}
                    value={descriptionEn}
                    onChange={setDescriptionEn}
                    error={error?.fieldError("description.en")}
                  />
                  <ProductDescriptionField
                    label={t("products.descriptionFr")}
                    value={descriptionFr}
                    onChange={setDescriptionFr}
                    error={error?.fieldError("description.fr")}
                  />
                </div>
              </FieldSet>

              <FieldSeparator />
              <FieldSet>
                <FieldLegend>{t("products.attributes")}</FieldLegend>
                <SelectField
                  label={t("products.attributeSet")}
                  options={setOptions}
                  value={attributeSetId ?? ""}
                  onChange={requestSetChange}
                  error={error?.fieldError("attributeSetId")}
                />
                {fields.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {fields.map((field) => (
                      <AttributeInput
                        key={field.id}
                        field={field}
                        value={values[field.id] ?? null}
                        onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                        error={error?.fieldError(`attributeValues.${field.id}`)}
                      />
                    ))}
                  </div>
                ) : null}
                {archivedValues.length > 0 && attributeSetId === product?.attributeSet?.id ? (
                  <FieldDescription>
                    {t("products.archivedKept")}:{" "}
                    {archivedValues.map((v) => `${localize(v.name)}: ${v.optionLabel ? localize(v.optionLabel) : String(v.value)}`).join(", ")}
                  </FieldDescription>
                ) : null}
              </FieldSet>
            </FieldGroup>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("common.cancel")}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={submitting}>
                {submitting ? t("common.saving") : product ? t("products.saveProduct") : t("products.createProduct")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingSetId !== undefined}
        title={t("products.changeSetTitle")}
        description={t("products.changeSetWarning")}
        confirmLabel={t("products.changeSet")}
        onConfirm={() => applySetChange(pendingSetId ?? null)}
        onCancel={() => setPendingSetId(undefined)}
      />
    </>
  );
}
