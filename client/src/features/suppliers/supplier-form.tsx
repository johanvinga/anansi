import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { FieldError, FieldGroup, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { Supplier } from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { CategoryEditor } from "./category-editor";
import { chipsFrom, toCategoryInputs, type CategoryChip } from "./category-chips";

interface SupplierFormProps {
  supplier?: Supplier;
  onSaved: (supplier: Supplier) => void;
  onCancel: () => void;
}

type AddressKey = "street" | "city" | "stateRegion" | "postalCode" | "country";

const ADDRESS_FIELDS: { key: AddressKey; label: string }[] = [
  { key: "street", label: "Street" },
  { key: "city", label: "City" },
  { key: "stateRegion", label: "State / region" },
  { key: "postalCode", label: "Postal code" },
  { key: "country", label: "Country" },
];

/** Create or edit a supplier's name, address, and categories (FR-SUP-01, FR-SUP-04). */
export function SupplierForm({ supplier, onSaved, onCancel }: SupplierFormProps) {
  const [name, setName] = useState(supplier?.name ?? "");
  const [address, setAddress] = useState<Record<AddressKey, string>>({
    street: supplier?.street ?? "",
    city: supplier?.city ?? "",
    stateRegion: supplier?.stateRegion ?? "",
    postalCode: supplier?.postalCode ?? "",
    country: supplier?.country ?? "",
  });
  const [categories, setCategories] = useState<CategoryChip[]>(supplier ? chipsFrom(supplier.categories) : []);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const body = { name, ...address, categories: toCategoryInputs(categories) };
    try {
      const result = supplier
        ? await apiRequest<{ supplier: Supplier }>("PUT", `/suppliers/${supplier.id}`, body)
        : await apiRequest<{ supplier: Supplier }>("POST", "/suppliers", body);
      onSaved(result.supplier);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="gap-6 py-6">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
        <CardContent className="px-6">
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <FormField label="Name" name="name" value={name} onChange={setName} required error={error?.fieldError("name")} />
            <FieldSet>
              <FieldLegend>Address</FieldLegend>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {ADDRESS_FIELDS.map((field) => (
                  <FormField
                    key={field.key}
                    label={field.label}
                    name={field.key}
                    value={address[field.key]}
                    onChange={(value) => setAddress({ ...address, [field.key]: value })}
                    error={error?.fieldError(field.key)}
                  />
                ))}
              </div>
            </FieldSet>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend>Categories</FieldLegend>
              <CategoryEditor value={categories} onChange={setCategories} />
              {error?.fieldError("categories") ? <FieldError>{error.fieldError("categories")}</FieldError> : null}
            </FieldSet>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={submitting}>
            {submitting ? "Saving…" : supplier ? "Save changes" : "Create supplier"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
