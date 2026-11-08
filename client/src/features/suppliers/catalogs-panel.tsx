import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, apiUpload, errorMessage, ApiError } from "../../api/client";
import { formatSize } from "../../api/format";
import type { Catalog } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PdfFileField } from "../../components/pdf-file-field";
import { TableEmptyRow } from "../../components/table-empty-row";

interface CatalogsPanelProps {
  supplierId: string;
  isAdmin: boolean;
}

/** Lists, uploads, edits, downloads, and deletes a supplier's catalogs (FR-CLG-01..07). */
export function CatalogsPanel({ supplierId, isAdmin }: CatalogsPanelProps) {
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Catalog | null>(null);
  const [deleting, setDeleting] = useState<Catalog | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiRequest<{ items: Catalog[] }>("GET", `/suppliers/${supplierId}/catalogs`);
      setCatalogs(result.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [supplierId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiRequest<void>("DELETE", `/catalogs/${target.id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin ? <CatalogUploadForm supplierId={supplierId} onUploaded={load} /> : null}

      <ErrorAlert message={error} />

      <Card className="gap-0 py-0">
        <Table aria-label="Supplier catalogs">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Last updated</TableHead>
              <TableHead className="pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalogs.length === 0 ? <TableEmptyRow colSpan={6} message="No catalogs yet." /> : null}
            {catalogs.map((catalog) => (
              <TableRow key={catalog.id}>
                <TableCell className="pl-4 font-medium">{catalog.name}</TableCell>
                <TableCell>
                  {catalog.version ? <Badge variant="outline">{catalog.version}</Badge> : "—"}
                </TableCell>
                <TableCell>{catalog.originalFileName}</TableCell>
                <TableCell>{formatSize(catalog.sizeBytes)}</TableCell>
                <TableCell>{new Date(catalog.updatedAt).toLocaleDateString()}</TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <IconAction
                      label={`Download ${catalog.name}`}
                      icon={Download}
                      href={`/api/v1/catalogs/${catalog.id}/download`}
                    />
                    {isAdmin ? (
                      <>
                        <IconAction label={`Edit ${catalog.name}`} icon={Pencil} onClick={() => setEditing(catalog)} />
                        <IconAction
                          label={`Delete ${catalog.name}`}
                          icon={Trash2}
                          destructive
                          onClick={() => setDeleting(catalog)}
                        />
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {editing ? (
        <CatalogEditDialog
          catalog={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? "catalog"}?`}
        description="The catalog and its file will be permanently removed. This cannot be undone."
        confirmLabel="Delete catalog"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

interface CatalogUploadFormProps {
  supplierId: string;
  onUploaded: () => void;
}

function CatalogUploadForm({ supplierId, onUploaded }: CatalogUploadFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose a PDF file to upload.");
      return;
    }
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("name", name.trim());
    if (version.trim()) form.append("version", version.trim());
    try {
      await apiUpload(`/suppliers/${supplierId}/catalogs`, form);
      setFile(null);
      setResetKey((key) => key + 1);
      setName("");
      setVersion("");
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card className="gap-6 py-6">
      <form onSubmit={handleUpload} noValidate className="flex flex-col gap-6">
        <CardHeader className="px-6">
          <CardTitle>
            <h2>Add catalog</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-6">
          <FieldGroup>
            <ErrorAlert message={error} />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Name" name="name" value={name} onChange={setName} required />
              <FormField label="Version" name="version" value={version} onChange={setVersion} />
            </div>
            <PdfFileField file={file} onChange={setFile} resetKey={resetKey} />
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end border-t px-6 py-4">
          <Button type="submit" size="lg" disabled={uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

interface CatalogEditDialogProps {
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => void;
}

function CatalogEditDialog({ catalog, onClose, onSaved }: CatalogEditDialogProps) {
  // Version is optional (FR-CLG-01 relaxed); empty input clears it.
  const [name, setName] = useState(catalog.name);
  const [version, setVersion] = useState(catalog.version ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("PATCH", `/catalogs/${catalog.id}`, {
        name: name.trim(),
        // Empty string clears the optional version (the route treats "" as null).
        version: version.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Edit catalog</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error} />
            <FormField label="Name" name="name" value={name} onChange={setName} required />
            <FormField label="Version" name="version" value={version} onChange={setVersion} required />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
