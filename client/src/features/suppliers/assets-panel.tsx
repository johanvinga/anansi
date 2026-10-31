import { Dialog } from "@ark-ui/react/dialog";
import { FileUpload } from "@ark-ui/react/file-upload";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiRequest, apiUpload, errorMessage, ApiError } from "../../api/client";
import type { SupplierAsset } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { FormField } from "../../components/form-field";

interface AssetsPanelProps {
  supplierId: string;
  isAdmin: boolean;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.ceil(bytes / 1024)} KB`;
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
    <div className="page">
      {isAdmin ? <UploadForm supplierId={supplierId} onUploaded={load} /> : null}

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">File</th>
            <th scope="col">Size</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {assets.length === 0 ? (
            <tr>
              <td colSpan={5}>No assets uploaded yet.</td>
            </tr>
          ) : null}
          {assets.map((asset) => (
            <tr key={asset.id}>
              <td>
                {asset.title ?? "—"}
                {asset.description ? <div className="helper-text">{asset.description}</div> : null}
              </td>
              <td>{asset.originalFileName}</td>
              <td>{formatSize(asset.sizeBytes)}</td>
              <td>{new Date(asset.createdAt).toLocaleDateString()}</td>
              <td className="row-actions">
                <a className="secondary-button button-link" href={`/api/v1/assets/${asset.id}/download`}>
                  Download
                </a>
                {isAdmin ? (
                  <>
                    <button type="button" className="secondary-button" onClick={() => setEditing(asset)}>
                      Edit
                    </button>
                    <button type="button" className="danger-button" onClick={() => setDeleting(asset)}>
                      Delete
                    </button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [rejection, setRejection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = files[0];
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
      setFiles([]);
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
    <form className="card" onSubmit={handleUpload} noValidate>
      <h2>Upload PDF</h2>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {rejection ? (
        <p role="alert" className="form-error">
          {rejection}
        </p>
      ) : null}
      <FileUpload.Root
        maxFiles={1}
        accept={{ "application/pdf": [".pdf"] }}
        onFileChange={(details) => {
          setRejection(null);
          setFiles(details.acceptedFiles);
        }}
        onFileReject={(details) => {
          const reason = details.files[0]?.errors[0];
          setRejection(reason === "TOO_MANY_FILES" ? "Upload one file at a time." : "Only PDF files can be uploaded.");
        }}
      >
        <FileUpload.Dropzone className="dropzone">
          <FileUpload.Label>Drag a PDF here, or</FileUpload.Label>
          <FileUpload.Trigger className="secondary-button">Choose PDF</FileUpload.Trigger>
        </FileUpload.Dropzone>
        <FileUpload.HiddenInput />
        <FileUpload.ItemGroup>
          {files.map((file) => (
            <FileUpload.Item key={file.name} file={file}>
              <FileUpload.ItemName />
              <FileUpload.ItemSizeText />
            </FileUpload.Item>
          ))}
        </FileUpload.ItemGroup>
      </FileUpload.Root>
      <FormField label="Title (optional)" name="title" value={title} onChange={setTitle} />
      <FormField label="Description (optional)" name="description" value={description} onChange={setDescription} />
      <button type="submit" className="primary-button" disabled={uploading}>
        {uploading ? "Uploading…" : "Upload"}
      </button>
    </form>
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
    <Dialog.Root open onOpenChange={(details) => !details.open && onClose()}>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Positioner className="dialog-positioner">
        <Dialog.Content className="card dialog">
          <form onSubmit={handleSubmit} noValidate>
            <Dialog.Title>Edit file details</Dialog.Title>
            {error ? (
              <p role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <FormField label="Title" name="title" value={title} onChange={setTitle} />
            <FormField label="Description" name="description" value={description} onChange={setDescription} />
            <div className="dialog-actions">
              <Dialog.CloseTrigger className="secondary-button">Cancel</Dialog.CloseTrigger>
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
