import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { Page, Supplier } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { BulkDeleteControls, BulkSelectItem, BulkSelectPage } from "../../components/bulk-delete";
import { useBulkDelete } from "../../hooks/use-bulk-delete";
import { TagFilter } from "../../components/tag-filter";
import { IconAction } from "../../components/icon-action";
import { PageLayout } from "../../components/page-layout";
import { PageHeader } from "../../components/page-header";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";
import { SupplierDetail, type DetailTab } from "./supplier-detail";
import { SupplierForm } from "./supplier-form";
import { PinItemButton } from "../../components/pin-item-button";
import { ShareItemButton } from "../../components/share-item-button";
import { usePagedList, usePageClamp } from "../../lib/use-paged-list";

const DETAIL_TAB_KEYS: readonly DetailTab[] = ["details", "categories", "assets", "catalogs", "products"];

function isDetailTab(value: string): value is DetailTab {
  return DETAIL_TAB_KEYS.includes(value as DetailTab);
}

export function SuppliersPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const list = usePagedList();
  const { search, page, pageSize } = list;
  const categoryIds = list.getFilters("tag");
  const queryClient = useQueryClient();
  async function loadSuppliers(targetPage: number, size: number) {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(size) });
    if (search) params.set("q", search);
    for (const id of categoryIds) params.append("tag", id);
    return apiRequest<Page<Supplier>>("GET", `/suppliers?${params.toString()}`);
  }
  const suppliersQuery = useQuery({
    queryKey: ["suppliers", "list", { page, pageSize, search, categoryIds }],
    queryFn: () => loadSuppliers(page, pageSize),
    placeholderData: keepPreviousData,
  });
  const result = suppliersQuery.data;
  usePageClamp(list, result?.total);
  const bulk = useBulkDelete({
    scope: JSON.stringify({ search, categoryIds }),
    endpoint: "suppliers",
    loadPage: async (targetPage, size) => {
      const response = await loadSuppliers(targetPage, size);
      return { total: response.total, items: response.items.map((item) => ({ id: item.id, label: item.name })) };
    },
    onDeleted: async () => {
      await Promise.all(["suppliers", "supplier", "catalogs", "categories"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
  const visibleItems = (result?.items ?? []).map((item) => ({ id: item.id, label: item.name }));

  return (
    <>
      <PageLayout
        title={t("suppliers.title")}
        breadcrumbs={[{ label: t("suppliers.title") }]}
        toolbar={
          <>
            <SearchForm
              label={t("suppliers.searchLabel")}
              placeholder={t("suppliers.searchPlaceholder")}
              value={list.searchInput}
              onChange={list.setSearchInput}
              onSearch={list.submitSearch}
            />
            {isAdmin ? (
              <Button size="lg" onClick={() => navigate("/suppliers/new")}>
                <Plus />
                {t("suppliers.createSupplier")}
              </Button>
            ) : null}
          </>
        }
        filters={
          <TagFilter selected={categoryIds} onChange={(ids) => list.setFilters("tag", ids)} />
        }
      >
        {suppliersQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={errorMessage(suppliersQuery.error)} />
          </div>
        ) : null}

        {isAdmin ? <BulkDeleteControls selection={bulk} visibleItems={visibleItems} total={result?.total} pageSize={pageSize} warning={t("bulkDelete.suppliersWarning")} /> : null}
        <Table aria-label={t("suppliers.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {isAdmin ? <TableHead className="w-10 pl-4"><BulkSelectPage items={visibleItems} selection={bulk} /></TableHead> : null}
              <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
              <TableHead>{t("suppliers.city")}</TableHead>
              <TableHead>{t("suppliers.country")}</TableHead>
              <TableHead>{t("suppliers.categoriesLabel")}</TableHead>
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? <TableEmptyRow colSpan={isAdmin ? 6 : 5} message={t("suppliers.noSuppliers")} /> : null}
            {result?.items.map((supplier) => (
              <TableRow key={supplier.id}>
                {isAdmin ? <TableCell className="pl-4"><BulkSelectItem item={{ id: supplier.id, label: supplier.name }} selection={bulk} /></TableCell> : null}
                <TableCell className="pl-4 font-medium">
                  <Link to={`/suppliers/${supplier.id}`} className="hover:underline">
                    {supplier.name}
                  </Link>
                </TableCell>
                <TableCell>{supplier.city ?? "—"}</TableCell>
                <TableCell>{supplier.country ?? "—"}</TableCell>
                <TableCell>
                  {supplier.tags.length === 0 ? (
                    "—"
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {supplier.tags.map((tag) => (
                        <Badge key={tag.id} variant="secondary">
                          {localize(tag.name)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <PinItemButton
                    itemType="supplier"
                    itemId={supplier.id}
                    label={supplier.name}
                    initialPinned={supplier.pinned}
                    onChange={() => void queryClient.invalidateQueries({ queryKey: ["suppliers"] })}
                  />
                  <ShareItemButton itemType="supplier" itemId={supplier.id} itemName={supplier.name} iconOnly />
                  <IconAction
                    label={t("suppliers.viewSupplier", { name: supplier.name })}
                    icon={Eye}
                    onClick={() => navigate(`/suppliers/${supplier.id}`)}
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
    </>
  );
}

export function SupplierNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title={t("suppliers.createSupplier")}
        breadcrumbs={[{ label: t("suppliers.title"), to: "/suppliers" }, { label: t("suppliers.createSupplier") }]}
      />
      <SupplierForm
        onCancel={() => navigate("/suppliers")}
        onSaved={(supplier) => navigate(`/suppliers/${supplier.id}`)}
      />
    </>
  );
}

export function SupplierDetailPage() {
  const { supplierId, tab } = useParams<{ supplierId: string; tab?: string }>();
  const navigate = useNavigate();

  if (!supplierId) {
    return <Navigate to="/suppliers" replace />;
  }
  if (tab !== undefined && !isDetailTab(tab)) {
    return <Navigate to={`/suppliers/${supplierId}`} replace />;
  }

  const activeTab: DetailTab = tab ?? "details";
  return (
    <SupplierDetail
      supplierId={supplierId}
      tab={activeTab}
      onTabChange={(nextTab) =>
        navigate(nextTab === "details" ? `/suppliers/${supplierId}` : `/suppliers/${supplierId}/${nextTab}`)
      }
      onBack={() => navigate("/suppliers")}
      onDeleted={() => navigate("/suppliers", { replace: true })}
    />
  );
}
