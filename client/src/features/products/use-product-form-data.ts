import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { loadSettings } from "../../api/settings";
import type {
  AttributeField,
  AttributeSetSummary,
  Page,
  Supplier,
} from "../../api/types";

interface ProductFormData {
  currencies: string[];
  defaultCurrency: string | null;
  suppliers: Supplier[];
  sets: AttributeSetSummary[];
  fields: AttributeField[];
  error: ApiError | null;
}

function toApiError(error: unknown): ApiError {
  return new ApiError(500, "INTERNAL_ERROR", errorMessage(error));
}

export function useProductFormData(attributeSetId: string | null): ProductFormData {
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const suppliersQuery = useQuery({
    queryKey: ["suppliers", "picker", 100],
    queryFn: async () => (await apiRequest<Page<Supplier>>("GET", "/suppliers?pageSize=100")).items,
  });
  const setsQuery = useQuery({
    queryKey: ["attribute-sets"],
    queryFn: async () =>
      (await apiRequest<{ items: AttributeSetSummary[] }>("GET", "/attribute-sets")).items,
  });
  const fieldsQuery = useQuery({
    queryKey: ["attribute-set-fields", attributeSetId],
    enabled: attributeSetId !== null,
    queryFn: async () => {
      const result = await apiRequest<{ attributeSet: { fields: ProductFormData["fields"] } }>(
        "GET",
        `/attribute-sets/${attributeSetId}`,
      );
      return result.attributeSet.fields.filter((field) => !field.isArchived);
    },
  });
  const queryError =
    settingsQuery.error ?? suppliersQuery.error ?? setsQuery.error ?? fieldsQuery.error;

  return {
    currencies: settingsQuery.data?.currencies ?? [],
    defaultCurrency: settingsQuery.data?.defaultCurrency ?? null,
    suppliers: suppliersQuery.data ?? [],
    sets: setsQuery.data ?? [],
    fields: fieldsQuery.data ?? [],
    error: queryError ? toApiError(queryError) : null,
  };
}
