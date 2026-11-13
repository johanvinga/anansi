import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
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

const PAGE_SIZE = 25;

/** Global catalogs list: every supplier's catalogs in one table, searchable by name/version/
 * supplier, filterable by supplier categories, newest first (FR-CLG-04 global view). */
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
  const queryClient = useQueryClient();
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

        {categoriesQuery.error || catalogsQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={categoriesQuery.error ? errorMessage(categoriesQuery.error) : catalogsQuery.error ? errorMessage(catalogsQuery.error) : null} />
          </div>
        ) : null}

        <Table aria-label={t("catalogs.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("catalogs.catalogName")}</TableHead>
              <TableHead>{t("catalogs.pdfFile")}</TableHead>
              <TableHead>{t("catalogs.supplier")}</TableHead>
              <TableHead>{t("suppliers.categoriesLabel")}</TableHead>
              <TableHead>{t("catalogs.uploadedAt")}</TableHead>
              <TableHead>{t("catalogs.analysis")}</TableHead>
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? (
              <TableEmptyRow colSpan={7} message="No catalogs found." />
            ) : null}
            {result?.items.map((catalog) => (
              <TableRow key={catalog.id}>
                <TableCell className="pl-4 font-medium">{catalog.name}</TableCell>
                <TableCell>{catalog.originalFileName}</TableCell>
                <TableCell>{catalog.supplierName}</TableCell>
                <TableCell>
                  {catalog.supplierCategoryNames.length === 0 ? "—" : (
                    <div className="flex flex-wrap gap-1">
                      {catalog.supplierCategoryNames.map((name) => (
                        <Badge key={name} variant="secondary">{name}</Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>{formatDateTime(catalog.createdAt)}</TableCell>
                <TableCell>
                  <Badge variant={catalog.analysisStatus === "failed" ? "destructive" : "secondary"}>
                    {t(`catalogs.analysisStatus.${catalog.analysisStatus}`)}
                  </Badge>
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <Button type="button" variant="outline" size="sm" onClick={() => setReviewing(catalog)}>
                    <Eye />
                    {t("catalogs.reviewButton")}
                  </Button>
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
          }}
        />
      ) : null}
      {reviewing ? (
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