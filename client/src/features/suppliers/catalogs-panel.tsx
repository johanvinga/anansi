import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Download, Eye, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
      await queryClient.invalidateQueries({ queryKey: ["catalogs", "supplier", supplierId] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin ? <CatalogUploadForm supplierId={supplierId} onUploaded={refresh} /> : null}

      <ErrorAlert message={error ?? (catalogsQuery.error ? errorMessage(catalogsQuery.error) : settingsQuery.error ? errorMessage(settingsQuery.error) : null)} />

      <Card className="gap-0 py-0">
        <Table aria-label={t("suppliers.catalogs")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
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
            {catalogs.length === 0 ? <TableEmptyRow colSpan={analysisEnabled ? 8 : 7} message={t("suppliers.noCatalogs")} /> : null}
            {catalogs.map((catalog) => (
              <TableRow key={catalog.id}>
                <TableCell className="pl-4 font-medium">{catalog.name}</TableCell>
                <TableCell>
                  {catalog.version ? <Badge variant="outline">{catalog.version}</Badge> : "—"}
                </TableCell>
                <TableCell>{catalog.originalFileName}</TableCell>
                <TableCell>{formatSize(catalog.sizeBytes)}</TableCell>
                <TableCell>{new Date(catalog.updatedAt).toLocaleDateString()}</TableCell>
                <TableCell>{catalog.categories.map((category) => <Badge key={category.id} variant="secondary">{localize(category.name)}</Badge>)}</TableCell>
                {analysisEnabled ? <TableCell>
                  <Badge variant={catalog.analysisStatus === "failed" ? "destructive" : "secondary"}>
                    {t(`catalogs.analysisStatus.${catalog.analysisStatus}`)}
                  </Badge>
                </TableCell> : null}
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
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

interface CatalogUploadFormProps {
  supplierId: string;
  onUploaded: () => void;
}

function CatalogUploadForm({ supplierId, onUploaded }: CatalogUploadFormProps) {
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
    if (!name.trim()) {
      setError(t("catalogs.nameRequired"));
      return;
    }
    setError(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("name", name.trim());
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
    <Card className="gap-6 py-6">
      <form onSubmit={handleUpload} noValidate className="flex flex-col gap-6">
        <CardHeader className="px-6">
          <CardTitle>
            <h2>{t("catalogs.addCatalog")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-6">
          <FieldGroup>
            <ErrorAlert message={error} />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label={t("suppliers.name")} name="name" value={name} onChange={setName} required />
              <FormField label={t("catalogs.version")} name="version" value={version} onChange={setVersion} />
            </div>
            <PdfFileField file={file} onChange={setFile} resetKey={resetKey} />
            <p>{t("catalogs.catalogCategories")}</p>
            <CategoryEditor value={categories} onChange={setCategories} />
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end border-t px-6 py-4">
          <Button type="submit" size="lg" disabled={uploading}>
            {uploading ? t("suppliers.uploading") : t("suppliers.upload")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
