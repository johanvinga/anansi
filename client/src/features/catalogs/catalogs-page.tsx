import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import { formatDateTime } from "../../api/format";
import type { CatalogWithSupplier, Category, Page } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";
import { UploadCatalogDialog } from "./upload-catalog-dialog";

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
  const [result, setResult] = useState<Page<CatalogWithSupplier> | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ items: Category[] }>("GET", "/categories")
      .then((res) => setCategories(res.items))
      .catch(() => setCategories([]));
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    for (const id of categoryIds) params.append("category", id);
    try {
      setResult(await apiRequest<Page<CatalogWithSupplier>>("GET", `/catalogs?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [page, search, categoryIds]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleCategory(id: string) {
    setPage(1);
    setCategoryIds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  return (
    <>
      <PageHeader title={t("catalogs.title")} breadcrumbs={[{ label: t("catalogs.title") }]} />

      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
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
      </div>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-1 border-t px-4 py-3">
          <span className="mr-1 text-sm text-muted-foreground">{t("suppliers.categoriesLabel")}:</span>
          {categories.map((category) => {
            const active = categoryIds.includes(category.id);
            return (
              <Badge
                key={category.id}
                variant={active ? "default" : "secondary"}
                className="cursor-pointer"
                onClick={() => toggleCategory(category.id)}
              >
                {localize(category.name)}
              </Badge>
            );
          })}
        </div>

        {error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={error} />
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
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? (
              <TableEmptyRow colSpan={6} message="No catalogs found." />
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
                <TableCell className="pr-4 text-right">
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
      </Card>

      {uploadOpen ? (
        <UploadCatalogDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            setPage(1);
            void load();
          }}
        />
      ) : null}
    </>
  );
}