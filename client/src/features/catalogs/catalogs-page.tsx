import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Eye, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { loadSettings } from "../../api/settings";
import { localize } from "../../api/translations";
import { formatDateTime } from "../../api/format";
import type { CatalogWithSupplier, Category, Page } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PageLayout } from "../../components/page-layout";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";
import { UploadCatalogDialog } from "./upload-catalog-dialog";
import { CatalogExtractionDialog } from "./catalog-extraction-dialog";
import { CatalogEditDialog } from "./catalog-edit-dialog";
import { ConfirmDialog } from "../../components/confirm-dialog";

const PAGE_SIZE = 25;

/** Global catalogs list: every supplier's catalogs in one table, searchable by name/version/
 * supplier, filterable by catalog or supplier categories, newest first (FR-CLG-04 global view). */
export function CatalogsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [reviewing, setReviewing] = useState<CatalogWithSupplier | null>(null);
  const [editing, setEditing] = useState<CatalogWithSupplier | null>(null);
  const [deleting, setDeleting] = useState<CatalogWithSupplier | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const analysisEnabled = settingsQuery.data?.catalogExtractionEnabled === true;
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await apiRequest<{ items: Category[] }>("GET", "/categories")).items,
  });
  const catalogsQuery = useQuery({
    queryKey: ["catalogs", "all", { page, pageSize: PAGE_SIZE, search, categoryIds }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search) params.set("q", search);
      for (const id of categoryIds) params.append("category", id);
      return apiRequest<Page<CatalogWithSupplier>>("GET", `/catalogs?${params.toString()}`);
    },
  });
  const categories = categoriesQuery.data ?? [];
  const result = catalogsQuery.data;

  function toggleCategory(id: string) {
    setPage(1);
    setCategoryIds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  async function deleteCatalog() {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    try {
      await apiRequest("DELETE", `/catalogs/${id}`);
      setDeleteError(null);
      void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
    } catch (error) {
      setDeleteError(errorMessage(error));
    }
  }

  return (
    <>
      <PageLayout
        title={t("catalogs.title")}
        breadcrumbs={[{ label: t("catalogs.title") }]}
        toolbar={
          <>
            <SearchForm
              label={t("catalogs.searchLabel")}
              placeholder={t("catalogs.searchPlaceholder")}
              value={query}
              onChange={setQuery}
              onSearch={() => {
                setPage(1);
                setSearch(query.trim());
              }}
            />
            {isAdmin ? (
              <Button size="lg" onClick={() => setUploadOpen(true)}>
                {t("catalogs.uploadCatalog")}
              </Button>
            ) : null}
          </>
        }
        filters={
          <>
            <span className="mr-1 text-sm text-muted-foreground">{t("suppliers.categoriesLabel")}:</span>
            {categories.map((category) => {
              const active = categoryIds.includes(category.id);
              return (
                <Button
                  key={category.id}
                  type="button"
                  variant={active ? "default" : "secondary"}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  aria-pressed={active}
                  onClick={() => toggleCategory(category.id)}
                >
                  {localize(category.name)}
                </Button>
              );
            })}
          </>
        }
      >

        {deleteError || categoriesQuery.error || catalogsQuery.error || settingsQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={deleteError ?? (categoriesQuery.error ? errorMessage(categoriesQuery.error) : catalogsQuery.error ? errorMessage(catalogsQuery.error) : settingsQuery.error ? errorMessage(settingsQuery.error) : null)} />
          </div>
        ) : null}

        <Table aria-label={t("catalogs.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("catalogs.catalogName")}</TableHead>
              <TableHead>{t("catalogs.pdfFile")}</TableHead>
              <TableHead>{t("catalogs.supplier")}</TableHead>
              <TableHead>{t("catalogs.catalogCategories")}</TableHead>
              <TableHead>{t("catalogs.uploadedAt")}</TableHead>
              {analysisEnabled ? <TableHead>{t("catalogs.analysis")}</TableHead> : null}
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? (
              <TableEmptyRow colSpan={analysisEnabled ? 7 : 6} message="No catalogs found." />
            ) : null}
            {result?.items.map((catalog) => (
              <TableRow key={catalog.id}>
                <TableCell className="pl-4 font-medium">{catalog.name}</TableCell>
                <TableCell>{catalog.originalFileName}</TableCell>
                <TableCell>{catalog.supplierName ?? t("catalogs.unassigned")}</TableCell>
                <TableCell>
                  {catalog.categories.length === 0 ? "—" : (
                    <div className="flex flex-wrap gap-1">
                      {catalog.categories.map((category) => (
                        <Badge key={category.id} variant="secondary">{localize(category.name)}</Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>{formatDateTime(catalog.createdAt)}</TableCell>
                {analysisEnabled ? <TableCell>
                  <Badge variant={catalog.analysisStatus === "failed" ? "destructive" : "secondary"}>
                    {t(`catalogs.analysisStatus.${catalog.analysisStatus}`)}
                  </Badge>
                </TableCell> : null}
                <TableCell className="pr-4 text-right">
                  {isAdmin ? <IconAction label={t("suppliers.editAria", { name: catalog.name })} icon={Pencil} onClick={() => setEditing(catalog)} /> : null}
                  {isAdmin ? <IconAction label={t("suppliers.deleteAria", { name: catalog.name })} icon={Trash2} destructive onClick={() => setDeleting(catalog)} /> : null}
                  {analysisEnabled ? <Button type="button" variant="outline" size="sm" onClick={() => setReviewing(catalog)}>
                    <Eye />
                    {t("catalogs.reviewButton")}
                  </Button> : null}
                  <IconAction
                    label={t("catalogs.downloadAria", { name: catalog.name })}
                    icon={Download}
                    href={`/api/v1/catalogs/${catalog.id}/download`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {result ? (
          <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
        ) : null}
      </PageLayout>

      {uploadOpen ? (
        <UploadCatalogDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            setPage(1);
            void queryClient.invalidateQueries({ queryKey: ["catalogs", "all"] });
            void queryClient.invalidateQueries({ queryKey: ["supplier"] });
            void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
            void queryClient.invalidateQueries({ queryKey: ["categories"] });
          }}
        />
      ) : null}
      {editing ? <CatalogEditDialog catalog={editing} onClose={() => setEditing(null)} onSaved={() => {
        setEditing(null);
        void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
        void queryClient.invalidateQueries({ queryKey: ["supplier"] });
        void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
        void queryClient.invalidateQueries({ queryKey: ["categories"] });
      }} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t("catalogs.confirmDeleteTitle", { name: deleting?.name ?? t("nav.catalogs") })}
        description={t("catalogs.confirmDeleteFileDescription")}
        confirmLabel={t("catalogs.deleteCatalog")}
        onConfirm={() => void deleteCatalog()}
        onCancel={() => setDeleting(null)}
      />
      {analysisEnabled && reviewing ? (
        <CatalogExtractionDialog
          catalog={reviewing}
          isAdmin={isAdmin}
          onClose={() => {
            setReviewing(null);
            void queryClient.invalidateQueries({ queryKey: ["catalogs", "all"] });
          }}
        />
      ) : null}
    </>
  );
}