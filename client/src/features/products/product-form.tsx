import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldDescription, FieldGroup, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field";
import { ErrorAlert } from "../../components/error-alert";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { loadSettings } from "../../api/settings";
import type {
  AttributeField,
  AttributeSetDetail,
  AttributeSetSummary,
  AttributeValue,
  Page,
  ProductDetail,
  Supplier,
} from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { FormField } from "../../components/form-field";
import { SelectField } from "../../components/select-field";
import { AttributeInput } from "./attribute-input";

interface ProductFormProps {
  /** When set, the form edits this product; otherwise it creates one. */
  product?: ProductDetail;
  defaultSupplierId?: string;
  onClose: () => void;
  onSaved: (product: ProductDetail) => void;
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
export function ProductForm({ product, defaultSupplierId, onClose, onSaved }: ProductFormProps) {
  const { t } = useTranslation();
  const [supplierId, setSupplierId] = useState<string | null>(product?.supplierId ?? defaultSupplierId ?? null);
  const [name, setName] = useState(product?.name ?? "");
  const [supplierSku, setSupplierSku] = useState(product?.supplierSku ?? "");
  const [minQuantity, setMinQuantity] = useState(product ? String(product.minQuantity) : "1");
  const [cost, setCost] = useState(product?.cost ?? "");
  const [currency, setCurrency] = useState<string | null>(product?.currency ?? null);
  const [attributeSetId, setAttributeSetId] = useState<string | null>(product?.attributeSet?.id ?? null);
  const [values, setValues] = useState<Record<string, AttributeValue>>(() => initialValues(product));
  const [fields, setFields] = useState<AttributeField[]>([]);
  const [pendingSetId, setPendingSetId] = useState<string | null | undefined>(undefined);

  const [currencies, setCurrencies] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [sets, setSets] = useState<AttributeSetSummary[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadSettings()
      .then((settings) => {
        setCurrencies(settings.currencies);
        setCurrency((current) => current ?? settings.defaultCurrency);
      })
      .catch((err: unknown) => setError(new ApiError(500, "INTERNAL_ERROR", errorMessage(err))));
    apiRequest<Page<Supplier>>("GET", "/suppliers?pageSize=100")
      .then((result) => setSuppliers(result.items))
      .catch(() => undefined);
    apiRequest<{ items: AttributeSetSummary[] }>("GET", "/attribute-sets")
      .then((result) => setSets(result.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!attributeSetId) {
      setFields([]);
      return;
    }
    apiRequest<{ attributeSet: AttributeSetDetail }>("GET", `/attribute-sets/${attributeSetId}`)
      .then((result) => setFields(result.attributeSet.fields.filter((f) => !f.isArchived)))
      .catch((err: unknown) => setError(new ApiError(500, "INTERNAL_ERROR", errorMessage(err))));
  }, [attributeSetId]);

  const supplierOptions = useMemo(() => {
    const options = suppliers.map((s) => ({ value: s.id, label: s.name }));
    // Keep the current supplier selectable even if it is not in the first page of results.
    if (product && !options.some((o) => o.value === product.supplierId)) {
      options.unshift({ value: product.supplierId, label: product.supplierName });
    }
    return options;
  }, [suppliers, product]);
  const currencyOptions = useMemo(() => currencies.map((c) => ({ value: c, label: c })), [currencies]);
  const setOptions = useMemo(() => [{ value: "", label: t("attributeSets.noneOption") }, ...sets.map((s) => ({ value: s.id, label: s.name }))], [sets, t]);

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
      name,
      supplierSku,
      minQuantity: minQuantity.trim() === "" ? null : Number(minQuantity),
      cost: cost.trim(),
      currency,
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

  return (
    <>
      <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>{product ? t("products.editAria", { name: product.name }) : t("products.createProduct")}</DialogTitle>
            </DialogHeader>
            <FieldGroup>
              {error && (error.details.length === 0 || unmatchedErrors.length > 0) ? (
                <ErrorAlert message={error.message} />
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label={t("suppliers.name")} value={name} onChange={setName} required error={error?.fieldError("name")} />
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
                  value={currency}
                  onChange={setCurrency}
                  required
                  error={error?.fieldError("currency")}
                />
              </div>

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
                    {archivedValues.map((v) => `${v.name}: ${v.optionLabel ?? String(v.value)}`).join(", ")}
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
