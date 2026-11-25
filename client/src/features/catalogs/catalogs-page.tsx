import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BookOpen, Download, Eye, MoreHorizontal, Pencil, Pin, Share2, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { loadSettings } from "../../api/settings";
import { localize } from "../../api/translations";
import { formatDateTime } from "../../api/format";
import type { CatalogWithSupplier, Page } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { BulkDeleteControls, BulkSelectItem, BulkSelectPage } from "../../components/bulk-delete";
import { useBulkDelete } from "../../hooks/use-bulk-delete";
import { CategoryTreeFilter } from "../../components/category-tree-filter";
import { PageLayout } from "../../components/page-layout";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";
import { UploadCatalogDialog } from "./upload-catalog-dialog";
import { CatalogExtractionDialog } from "./catalog-extraction-dialog";
import { CatalogEditDialog } from "./catalog-edit-dialog";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ShareItemDialog } from "../../components/share-item-dialog";

const PAGE_SIZE = 25;

interface CatalogActionsProps {
  catalog: CatalogWithSupplier;
  isAdmin: boolean;
  analysisEnabled: boolean;
  onEdit: (catalog: CatalogWithSupplier) => void;
  onDelete: (catalog: CatalogWithSupplier) => void;
  onReview: (catalog: CatalogWithSupplier) => void;
}

function CatalogActions({
  catalog,
  isAdmin,
  analysisEnabled,
  onEdit,
  onDelete,
  onReview,
}: CatalogActionsProps) {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    void apiRequest<{ pinned: boolean }>("GET", `/pins/catalog/${catalog.id}/status`)
      .then((result) => setPinned(result.pinned))
      .catch(() => setPinned(false));
  }, [catalog.id]);

  async function togglePin() {
    if (pinBusy) return;
    const previous = pinned;
    setPinBusy(true);
    setPinned(!previous);
    try {
      const result = await apiRequest<{ pinned: boolean }>(
        previous ? "DELETE" : "POST",
        "/pins",
        { itemType: "catalog", itemId: catalog.id },
      );
      setPinned(result.pinned);
    } catch {
      setPinned(previous);
    } finally {
      setPinBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("suppliers.actions")}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem asChild>
            <Link to={`/catalogs/${catalog.id}/workspace`}>
              <BookOpen />
              {t("catalogs.openWorkspace")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/api/v1/catalogs/${catalog.id}/download`}>
              <Download />
              {t("common.download")}
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={pinBusy} onSelect={() => void togglePin()}>
            <Pin className={pinned ? "fill-current" : ""} />
            {pinned ? t("pins.unpin") : t("pins.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShareOpen(true)}>
            <Share2 />
            {t("pins.share")}
          </DropdownMenuItem>
          {analysisEnabled ? (
            <DropdownMenuItem onSelect={() => onReview(catalog)}>
              <Eye />
              {t("catalogs.reviewButton")}
            </DropdownMenuItem>
          ) : null}
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onEdit(catalog)}>
                <Pencil />
                {t("common.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDelete(catalog)}
              >
                <Trash2 />
                {t("common.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ShareItemDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        itemType="catalog"
        itemId={catalog.id}
        itemName={catalog.name}
      />
    </>
  );
}

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
  async function loadCatalogs(targetPage: number, pageSize: number) {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) });
    if (search) params.set("q", search);
    for (const id of categoryIds) params.append("category", id);
    return apiRequest<Page<CatalogWithSupplier>>("GET", `/catalogs?${params.toString()}`);
  }
  const catalogsQuery = useQuery({
    queryKey: ["catalogs", "all", { page, pageSize: PAGE_SIZE, search, categoryIds }],
    queryFn: () => loadCatalogs(page, PAGE_SIZE),
  });
  const result = catalogsQuery.data;
  const bulk = useBulkDelete({
    scope: JSON.stringify({ search, categoryIds }),
    endpoint: "catalogs",
    loadPage: async (targetPage, pageSize) => {
      const response = await loadCatalogs(targetPage, pageSize);
      return { total: response.total, items: response.items.map((item) => ({ id: item.id, label: item.name })) };
    },
    onDeleted: async () => {
      setPage(1);
      await Promise.all(["catalogs", "supplier", "suppliers", "categories"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
  const visibleItems = (result?.items ?? []).map((item) => ({ id: item.id, label: item.name }));

  async function deleteCatalog() {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    try {
      await apiRequest("DELETE", `/catalogs/${id}`);
      bulk.remove(id);
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
          <CategoryTreeFilter selected={categoryIds} onChange={(ids) => { setPage(1); setCategoryIds(ids); }} />
        }
      >

        {deleteError || catalogsQuery.error || settingsQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={deleteError ?? (catalogsQuery.error ? errorMessage(catalogsQuery.error) : settingsQuery.error ? errorMessage(settingsQuery.error) : null)} />
          </div>
        ) : null}

        {isAdmin ? <BulkDeleteControls selection={bulk} visibleItems={visibleItems} total={result?.total} pageSize={PAGE_SIZE} warning={t("bulkDelete.catalogsWarning")} /> : null}
        <Table aria-label={t("catalogs.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {isAdmin ? <TableHead className="w-10 pl-4"><BulkSelectPage items={visibleItems} selection={bulk} /></TableHead> : null}
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
              <TableEmptyRow colSpan={(analysisEnabled ? 7 : 6) + (isAdmin ? 1 : 0)} message="No catalogs found." />
            ) : null}
            {result?.items.map((catalog) => (
              <TableRow key={catalog.id}>
                {isAdmin ? <TableCell className="pl-4"><BulkSelectItem item={{ id: catalog.id, label: catalog.name }} selection={bulk} /></TableCell> : null}
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
                  <CatalogActions
                    catalog={catalog}
                    isAdmin={isAdmin}
                    analysisEnabled={analysisEnabled}
                    onEdit={setEditing}
                    onDelete={setDeleting}
                    onReview={setReviewing}
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