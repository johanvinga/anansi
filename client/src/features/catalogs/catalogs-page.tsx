import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BookOpen, Download, Eye, MoreHorizontal, Pencil, Pin, ScanSearch, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
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
import type { CatalogWithSupplier, Page } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { BulkDeleteControls, BulkSelectItem, BulkSelectPage } from "../../components/bulk-delete";
import { useBulkDelete } from "../../hooks/use-bulk-delete";
import { TagFilter } from "../../components/tag-filter";
import { PageLayout } from "../../components/page-layout";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";
import { UploadCatalogDialog } from "./upload-catalog-dialog";
import { CatalogExtractionDialog } from "./catalog-extraction-dialog";
import { CatalogEditDialog } from "./catalog-edit-dialog";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { IconAction } from "../../components/icon-action";
import { PinItemButton } from "../../components/pin-item-button";
import { ShareItemButton } from "../../components/share-item-button";
import { usePagedList, usePageClamp } from "../../lib/use-paged-list";


interface CatalogActionsProps {
  catalog: CatalogWithSupplier;
  isAdmin: boolean;
  analysisEnabled: boolean;
  onEdit: (catalog: CatalogWithSupplier) => void;
  onDelete: (catalog: CatalogWithSupplier) => void;
  onReview: (catalog: CatalogWithSupplier) => void;
  onPinChange: () => void;
}

function CatalogActions({
  catalog,
  isAdmin,
  analysisEnabled,
  onEdit,
  onDelete,
  onReview,
  onPinChange,
}: CatalogActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-end gap-1">
      <PinItemButton
        itemType="catalog"
        itemId={catalog.id}
        label={catalog.name}
        initialPinned={catalog.pinned}
        onChange={onPinChange}
      />
      <ShareItemButton itemType="catalog" itemId={catalog.id} itemName={catalog.name} iconOnly />
      <IconAction
        label={t("catalogs.viewCatalog", { name: catalog.name })}
        icon={Eye}
        onClick={() => navigate(`/catalogs/${catalog.id}/workspace`)}
      />
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
          <DropdownMenuItem onSelect={() => onEdit(catalog)}>
            {isAdmin ? <Pencil /> : <BookOpen />}
            {isAdmin ? t("catalogs.editCatalog") : t("catalogs.catalogDetails")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/api/v1/catalogs/${catalog.id}/download`}>
              <Download />
              {t("common.download")}
            </a>
          </DropdownMenuItem>
          {analysisEnabled ? (
            <DropdownMenuItem onSelect={() => onReview(catalog)}>
              <ScanSearch />
              {t("catalogs.reviewButton")}
            </DropdownMenuItem>
          ) : null}
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
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
    </div>
  );
}

/** Global catalogs list: every supplier's catalogs in one table, searchable by name/version/
 * supplier, filterable by catalog or supplier categories, newest first (FR-CLG-04 global view). */
export function CatalogsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const list = usePagedList();
  const { search, page, pageSize } = list;
  const categoryIds = list.getFilters("tag");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [reviewing, setReviewing] = useState<CatalogWithSupplier | null>(null);
  const [editing, setEditing] = useState<CatalogWithSupplier | null>(null);
  const [deleting, setDeleting] = useState<CatalogWithSupplier | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const analysisEnabled = settingsQuery.data?.catalogExtractionEnabled === true;
  async function loadCatalogs(targetPage: number, size: number) {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(size) });
    if (search) params.set("q", search);
    for (const id of categoryIds) params.append("tag", id);
    return apiRequest<Page<CatalogWithSupplier>>("GET", `/catalogs?${params.toString()}`);
  }
  const catalogsQuery = useQuery({
    queryKey: ["catalogs", "all", { page, pageSize, search, categoryIds }],
    queryFn: () => loadCatalogs(page, pageSize),
    placeholderData: keepPreviousData,
  });
  const result = catalogsQuery.data;
  usePageClamp(list, result?.total);
  const bulk = useBulkDelete({
    scope: JSON.stringify({ search, categoryIds }),
    endpoint: "catalogs",
    loadPage: async (targetPage, size) => {
      const response = await loadCatalogs(targetPage, size);
      return { total: response.total, items: response.items.map((item) => ({ id: item.id, label: item.name })) };
    },
    onDeleted: async () => {
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
              value={list.searchInput}
              onChange={list.setSearchInput}
              onSearch={list.submitSearch}
            />
            {isAdmin ? (
              <Button size="lg" onClick={() => setUploadOpen(true)}>
                {t("catalogs.uploadCatalog")}
              </Button>
            ) : null}
          </>
        }
        filters={
          <TagFilter selected={categoryIds} onChange={(ids) => list.setFilters("tag", ids)} />
        }
      >

        {deleteError || catalogsQuery.error || settingsQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={deleteError ?? (catalogsQuery.error ? errorMessage(catalogsQuery.error) : settingsQuery.error ? errorMessage(settingsQuery.error) : null)} />
          </div>
        ) : null}

        {isAdmin ? <BulkDeleteControls selection={bulk} visibleItems={visibleItems} total={result?.total} pageSize={pageSize} warning={t("bulkDelete.catalogsWarning")} /> : null}
        <Table aria-label={t("catalogs.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {isAdmin ? <TableHead className="w-10 pl-4"><BulkSelectPage items={visibleItems} selection={bulk} /></TableHead> : null}
              <TableHead className="pl-4">{t("catalogs.catalogName")}</TableHead>
              <TableHead>{t("catalogs.supplier")}</TableHead>
              <TableHead>{t("catalogs.catalogCategories")}</TableHead>
              {analysisEnabled ? <TableHead>{t("catalogs.analysis")}</TableHead> : null}
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? (
              <TableEmptyRow colSpan={(analysisEnabled ? 5 : 4) + (isAdmin ? 1 : 0)} message="No catalogs found." />
            ) : null}
            {result?.items.map((catalog) => (
              <TableRow key={catalog.id}>
                {isAdmin ? <TableCell className="pl-4"><BulkSelectItem item={{ id: catalog.id, label: catalog.name }} selection={bulk} /></TableCell> : null}
                <TableCell className="pl-4 font-medium">
                  <span className="inline-flex items-center gap-2">
                    {catalog.name}
                    {catalog.pinned ? (
                      <Pin className="size-3.5 fill-current text-primary" aria-label={t("pins.pinned")} />
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>{catalog.supplierName ?? t("catalogs.unassigned")}</TableCell>
                <TableCell>
                  {catalog.tags.length === 0 ? "—" : (
                    <div className="flex flex-wrap gap-1">
                      {catalog.tags.map((tag) => (
                        <Badge key={tag.id} variant="secondary">{localize(tag.name)}</Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
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
                    onPinChange={() => void queryClient.invalidateQueries({ queryKey: ["catalogs"] })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {result ? (
          <PaginationControls total={result.total} pageSize={pageSize} page={page} onPageChange={list.setPage} />
        ) : null}
      </PageLayout>

      {uploadOpen ? (
        <UploadCatalogDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            list.replacePage(1);
            void queryClient.invalidateQueries({ queryKey: ["catalogs", "all"] });
            void queryClient.invalidateQueries({ queryKey: ["supplier"] });
            void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
            void queryClient.invalidateQueries({ queryKey: ["categories"] });
          }}
        />
      ) : null}
      {editing ? <CatalogEditDialog catalog={editing} readOnly={!isAdmin} onClose={() => setEditing(null)} onSaved={() => {
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