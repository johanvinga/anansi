import { useEffect, useState, type FormEvent } from "react";
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
import { FieldGroup } from "@/components/ui/field";
import { ApiError, apiRequest, apiUpload, errorMessage } from "../../api/client";
import type { Supplier } from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { PdfFileField } from "../../components/pdf-file-field";
import { SelectField } from "../../components/select-field";
import { CategoryEditor } from "../suppliers/category-editor";
import { type CategoryChip } from "../suppliers/category-chips";

interface UploadCatalogDialogProps {
  onClose: () => void;
  onUploaded: () => void;
}

const SUPPLIER_PICKER_LIMIT = 100;

/** Uploads a catalog PDF to an existing supplier or a brand-new one created here. */
export function UploadCatalogDialog({ onClose, onUploaded }: UploadCatalogDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [addNewSupplier, setAddNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [categories, setCategories] = useState<CategoryChip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiRequest<{ items: Supplier[] }>(
      "GET",
      `/suppliers?page=1&pageSize=${SUPPLIER_PICKER_LIMIT}`,
    )
      .then((res) => setSuppliers(res.items))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError("Choose a PDF file to upload.");
      return;
    }
    if (!name.trim()) {
      setError("Catalog name is required.");
      return;
    }
    if (addNewSupplier) {
      if (!newSupplierName.trim()) {
        setError("Supplier name is required.");
        return;
      }
    } else if (!supplierId) {
      setError("Select a supplier or add a new one.");
      return;
    }
    setSubmitting(true);
    try {
      // The API needs a supplier up front, so a new supplier is created first (FR-SUP-01);
      // only name and categories are mandatory.
      let targetId = supplierId;
      if (addNewSupplier) {
        const created = await apiRequest<{ supplier: Supplier }>("POST", "/suppliers", {
          name: newSupplierName.trim(),
          categories: categories.map((chip) => (chip.id ? { id: chip.id } : { name: chip.name })),
        });
        targetId = created.supplier.id;
      }
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim());
      if (version.trim()) form.append("version", version.trim());
      await apiUpload(`/suppliers/${targetId}/catalogs`, form);
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Upload catalog</DialogTitle>
            <DialogDescription>
              The PDF is stored under a generated name; the catalog keeps its own display name.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error} />
            <PdfFileField file={file} onChange={setFile} />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Catalog name" name="name" value={name} onChange={setName} required />
              <FormField label="Version (optional)" name="version" value={version} onChange={setVersion} />
            </div>
            {addNewSupplier ? (
              <div className="flex flex-col gap-4 rounded-lg border p-4">
                <FormField
                  label="Supplier name"
                  name="newSupplierName"
                  value={newSupplierName}
                  onChange={setNewSupplierName}
                  required
                />
                <CategoryEditor value={categories} onChange={setCategories} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAddNewSupplier(false);
                    setNewSupplierName("");
                    setCategories([]);
                  }}
                >
                  Use an existing supplier instead
                </Button>
              </div>
            ) : (
              <SelectField
                label="Supplier"
                options={suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name }))}
                value={supplierId}
                onChange={setSupplierId}
                required
              />
            )}
            {!addNewSupplier ? (
              <Button
                type="button"
                variant="link"
                className="justify-start px-0"
                onClick={() => setAddNewSupplier(true)}
              >
                Add a new supplier
              </Button>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}