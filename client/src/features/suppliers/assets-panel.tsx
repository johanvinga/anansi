import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, Pencil, Trash2 } from "lucide-react";
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
import type { SupplierAsset } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PdfFileField } from "../../components/pdf-file-field";
import { TableEmptyRow } from "../../components/table-empty-row";

interface AssetsPanelProps {
  supplierId: string;
  isAdmin: boolean;
}

/** Lists, uploads, edits, downloads, and deletes a supplier's PDF assets (FR-AST-01..10). */
export function AssetsPanel({ supplierId, isAdmin }: AssetsPanelProps) {
  const [assets, setAssets] = useState<SupplierAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplierAsset | null>(null);
  const [deleting, setDeleting] = useState<SupplierAsset | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiRequest<{ items: SupplierAsset[] }>("GET", `/suppliers/${supplierId}/assets`);
      setAssets(result.items);
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
      await apiRequest<void>("DELETE", `/assets/${target.id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin ? <UploadForm supplierId={supplierId} onUploaded={load} /> : null}

      <ErrorAlert message={error} />

      <Card className="gap-0 py-0">
        <Table aria-label="Supplier assets">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">Title</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assets.length === 0 ? <TableEmptyRow colSpan={5} message="No assets uploaded yet." /> : null}
            {assets.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell className="pl-4 whitespace-normal">
                  <div className="font-medium">{asset.title ?? "—"}</div>
                  {asset.description ? <div className="text-muted-foreground">{asset.description}</div> : null}
                </TableCell>
                <TableCell>{asset.originalFileName}</TableCell>
                <TableCell>{formatSize(asset.sizeBytes)}</TableCell>
                <TableCell>{new Date(asset.createdAt).toLocaleDateString()}</TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <IconAction
                      label={`Download ${asset.originalFileName}`}
                      icon={Download}
                      href={`/api/v1/assets/${asset.id}/download`}
                    />
                    {isAdmin ? (
                      <>
                        <IconAction label={`Edit ${asset.originalFileName}`} icon={Pencil} onClick={() => setEditing(asset)} />
                        <IconAction
                          label={`Delete ${asset.originalFileName}`}
                          icon={Trash2}
                          destructive
                          onClick={() => setDeleting(asset)}
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
        <AssetEditDialog
          asset={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.originalFileName ?? "file"}?`}
        description="The file and its details will be permanently removed."
        confirmLabel="Delete file"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

interface UploadFormProps {
  supplierId: string;
  onUploaded: () => void;
}

function UploadForm({ supplierId, onUploaded }: UploadFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose a PDF file to upload.");
      return;
    }
    setError(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    if (title.trim()) form.append("title", title.trim());
    if (description.trim()) form.append("description", description.trim());
    try {
      await apiUpload(`/suppliers/${supplierId}/assets`, form);
      setFile(null);
      setResetKey((key) => key + 1);
      setTitle("");
      setDescription("");
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
            <h2>Upload PDF</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-6">
          <FieldGroup>
            <ErrorAlert message={error} />
            <PdfFileField file={file} onChange={setFile} resetKey={resetKey} />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Title (optional)" name="title" value={title} onChange={setTitle} />
              <FormField label="Description (optional)" name="description" value={description} onChange={setDescription} />
            </div>
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

interface AssetEditDialogProps {
  asset: SupplierAsset;
  onClose: () => void;
  onSaved: () => void;
}

function AssetEditDialog({ asset, onClose, onSaved }: AssetEditDialogProps) {
  const [title, setTitle] = useState(asset.title ?? "");
  const [description, setDescription] = useState(asset.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("PATCH", `/assets/${asset.id}`, {
        title: title.trim(),
        description: description.trim(),
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
            <DialogTitle>Edit file details</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error} />
            <FormField label="Title" name="title" value={title} onChange={setTitle} />
            <FormField label="Description" name="description" value={description} onChange={setDescription} />
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
