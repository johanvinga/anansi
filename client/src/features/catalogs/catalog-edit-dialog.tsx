import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { apiRequest, errorMessage } from "../../api/client";
import type { Catalog } from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { SelectField } from "../../components/select-field";
import { CategoryEditor } from "../suppliers/category-editor";
import { chipsFrom, toCategoryInputs } from "../suppliers/category-chips";
import { loadCatalogSuppliers } from "./supplier-picker";

interface CatalogEditDialogProps {
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => void;
}

export function CatalogEditDialog({ catalog, onClose, onSaved }: CatalogEditDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(catalog.name);
  const [version, setVersion] = useState(catalog.version ?? "");
  const [supplierId, setSupplierId] = useState(catalog.supplierId);
  const [categories, setCategories] = useState(() => chipsFrom(catalog.categories));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const suppliers = useQuery({
    queryKey: ["suppliers", "catalog-picker"],
    queryFn: loadCatalogSuppliers,
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("PATCH", `/catalogs/${catalog.id}`, {
        name: name.trim(), version: version.trim() || null, supplierId, categories: toCategoryInputs(categories),
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <DialogHeader><DialogTitle>{t("catalogs.editCatalog")}</DialogTitle></DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error ?? (suppliers.error ? errorMessage(suppliers.error) : null)} />
            <FormField label={t("suppliers.name")} name="name" value={name} onChange={setName} required />
            <FormField label={t("catalogs.version")} name="version" value={version} onChange={setVersion} />
            <SelectField
              label={t("catalogs.supplier")}
              value={supplierId ?? ""}
              onChange={(value) => setSupplierId(value || null)}
              disabled={!suppliers.data}
              options={[{ value: "", label: t("catalogs.unassigned") }, ...(suppliers.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
            />
            <p>{t("catalogs.catalogCategories")}</p>
            <CategoryEditor value={categories} onChange={setCategories} />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">{t("common.cancel")}</Button></DialogClose>
            <Button type="submit" disabled={submitting || !suppliers.data}>{submitting ? t("common.saving") : t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
