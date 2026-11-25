import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Download, Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, apiUpload, errorMessage, ApiError } from "../../api/client";
import { loadSettings } from "../../api/settings";
import { formatSize } from "../../api/format";
import type { Catalog } from "../../api/types";
import { CatalogExtractionDialog } from "../catalogs/catalog-extraction-dialog";
import { CatalogEditDialog } from "../catalogs/catalog-edit-dialog";
import { CategoryEditor } from "./category-editor";
import { toCategoryInputs, type CategoryChip } from "./category-chips";
import { localize } from "../../api/translations";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { BulkDeleteControls, BulkSelectItem, BulkSelectPage } from "../../components/bulk-delete";
import { useBulkDelete } from "../../hooks/use-bulk-delete";
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
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Catalog | null>(null);
  const [deleting, setDeleting] = useState<Catalog | null>(null);
  const [reviewing, setReviewing] = useState<Catalog | null>(null);
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const analysisEnabled = settingsQuery.data?.catalogExtractionEnabled === true;
  const catalogsQuery = useQuery({
    queryKey: ["catalogs", "supplier", supplierId],
    queryFn: async () =>
      (await apiRequest<{ items: Catalog[] }>("GET", `/suppliers/${supplierId}/catalogs`)).items,
  });
  const catalogs = catalogsQuery.data ?? [];
  const bulk = useBulkDelete({
    scope: supplierId,
    endpoint: "catalogs",
    onDeleted: async () => {
      await Promise.all(["catalogs", "supplier", "suppliers", "categories"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
  const visibleItems = catalogs.map((item) => ({ id: item.id, label: item.name }));
  const refresh = () => {
    setError(null);
    void catalogsQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ["supplier", supplierId] });
    void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    void queryClient.invalidateQueries({ queryKey: ["categories"] });
  };

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiRequest<void>("DELETE", `/catalogs/${target.id}`);
      bulk.remove(target.id);
      await queryClient.invalidateQueries({ queryKey: ["catalogs", "supplier", supplierId] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin ? (
        <div className="flex justify-end">
          <Button onClick={() => setUploading(true)}>
            <Plus />
            {t("catalogs.addCatalog")}
          </Button>
        </div>
      ) : null}

      <ErrorAlert message={error ?? (catalogsQuery.error ? errorMessage(catalogsQuery.error) : settingsQuery.error ? errorMessage(settingsQuery.error) : null)} />

      <Card className="gap-0 py-0">
        {isAdmin ? <BulkDeleteControls selection={bulk} visibleItems={visibleItems} warning={t("bulkDelete.catalogsWarning")} /> : null}
        <Table aria-label={t("suppliers.catalogs")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {isAdmin ? <TableHead className="w-10 pl-4"><BulkSelectPage items={visibleItems} selection={bulk} /></TableHead> : null}
              <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
              <TableHead>{t("catalogs.version")}</TableHead>
              <TableHead>{t("catalogs.file")}</TableHead>
              <TableHead>{t("suppliers.size")}</TableHead>
              <TableHead>{t("suppliers.lastUpdated")}</TableHead>
              <TableHead>{t("catalogs.catalogCategories")}</TableHead>
              {analysisEnabled ? <TableHead>{t("catalogs.analysis")}</TableHead> : null}
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalogs.length === 0 ? <TableEmptyRow colSpan={(analysisEnabled ? 8 : 7) + (isAdmin ? 1 : 0)} message={t("suppliers.noCatalogs")} /> : null}
            {catalogs.map((catalog) => (
              <TableRow key={catalog.id}>
                {isAdmin ? <TableCell className="pl-4"><BulkSelectItem item={{ id: catalog.id, label: catalog.name }} selection={bulk} /></TableCell> : null}
                <TableCell className="pl-4 font-medium">{catalog.name}</TableCell>
                <TableCell>
                  {catalog.version ? <Badge variant="outline">{catalog.version}</Badge> : "—"}
                </TableCell>
                <TableCell>{catalog.originalFileName}</TableCell>
                <TableCell>{formatSize(catalog.sizeBytes)}</TableCell>
                <TableCell>{new Date(catalog.updatedAt).toLocaleDateString()}</TableCell>
                <TableCell>{catalog.tags.map((tag) => <Badge key={tag.id} variant="secondary">{localize(tag.name)}</Badge>)}</TableCell>
                {analysisEnabled ? <TableCell>
                  <Badge variant={catalog.analysisStatus === "failed" ? "destructive" : "secondary"}>
                    {t(`catalogs.analysisStatus.${catalog.analysisStatus}`)}
                  </Badge>
                </TableCell> : null}
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <Button asChild type="button" variant="outline" size="sm">
                      <Link to={`/catalogs/${catalog.id}/workspace`}>
                        <BookOpen />
                        {t("catalogs.openWorkspace")}
                      </Link>
                    </Button>
                    {analysisEnabled ? <Button type="button" variant="outline" size="sm" onClick={() => setReviewing(catalog)}>
                      <Eye />
                      {t("catalogs.reviewButton")}
                    </Button> : null}
                    <IconAction
                      label={t("suppliers.downloadAria", { name: catalog.name })}
                      icon={Download}
                      href={`/api/v1/catalogs/${catalog.id}/download`}
                    />
                    {isAdmin ? (
                      <>
                        <IconAction label={t("suppliers.editAria", { name: catalog.name })} icon={Pencil} onClick={() => setEditing(catalog)} />
                        <IconAction
                          label={t("suppliers.deleteAria", { name: catalog.name })}
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
            refresh();
            void queryClient.invalidateQueries({ queryKey: ["supplier"] });
            void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
            void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
            void queryClient.invalidateQueries({ queryKey: ["categories"] });
          }}
        />
      ) : null}

      {uploading ? (
        <CatalogUploadDialog
          supplierId={supplierId}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            refresh();
          }}
        />
      ) : null}

      {analysisEnabled && reviewing ? (
        <CatalogExtractionDialog
          catalog={reviewing}
          isAdmin={isAdmin}
          onClose={() => {
            setReviewing(null);
            void queryClient.invalidateQueries({ queryKey: ["catalogs", "supplier", supplierId] });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t("catalogs.confirmDeleteTitle", { name: deleting?.name ?? t("nav.catalogs") })}
        description={t("catalogs.confirmDeleteFileDescription")}
        confirmLabel={t("catalogs.deleteCatalog")}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

interface CatalogUploadDialogProps {
  supplierId: string;
  onClose: () => void;
  onUploaded: () => void;
}

function CatalogUploadDialog({ supplierId, onClose, onUploaded }: CatalogUploadDialogProps) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [categories, setCategories] = useState<CategoryChip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError(t("suppliers.choosePdf"));
      return;
    }
    setError(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    if (name.trim()) form.append("name", name.trim());
    if (version.trim()) form.append("version", version.trim());
    form.append("categories", JSON.stringify(toCategoryInputs(categories)));
    try {
      await apiUpload(`/suppliers/${supplierId}/catalogs`, form);
      setFile(null);
      setResetKey((key) => key + 1);
      setName("");
      setVersion("");
      setCategories([]);
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleUpload} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t("catalogs.addCatalog")}</DialogTitle>
            <DialogDescription>{t("catalogs.supplierUploadDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error} />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label={t("catalogs.catalogNameOptional")} name="name" value={name} onChange={setName} />
              <FormField label={t("catalogs.version")} name="version" value={version} onChange={setVersion} />
            </div>
            <PdfFileField file={file} onChange={setFile} resetKey={resetKey} />
            <p>{t("catalogs.catalogCategories")}</p>
            <CategoryEditor value={categories} onChange={setCategories} />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={uploading}>
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={uploading}>
              {uploading ? t("suppliers.uploading") : t("suppliers.upload")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
