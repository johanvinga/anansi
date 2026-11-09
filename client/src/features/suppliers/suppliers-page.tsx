import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Eye, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import type { Page, Supplier } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";
import { SupplierDetail, type DetailTab } from "./supplier-detail";
import { SupplierForm } from "./supplier-form";

const PAGE_SIZE = 25;
const DETAIL_TAB_KEYS: readonly DetailTab[] = ["details", "categories", "assets", "catalogs", "products"];

function isDetailTab(value: string): value is DetailTab {
  return DETAIL_TAB_KEYS.includes(value as DetailTab);
}

export function SuppliersPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<Supplier> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    try {
      setResult(await apiRequest<Page<Supplier>>("GET", `/suppliers?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title={t("suppliers.title")} breadcrumbs={[{ label: t("suppliers.title") }]} />
      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
        <SearchForm
          label={t("suppliers.searchLabel")}
          placeholder={t("suppliers.searchPlaceholder")}
          value={query}
          onChange={setQuery}
          onSearch={() => {
            setPage(1);
            setSearch(query.trim());
          }}
        />
        {isAdmin ? (
          <Button size="lg" onClick={() => navigate("/suppliers/new")}>
            <Plus />
            {t("suppliers.createSupplier")}
          </Button>
        ) : null}
      </div>
      <Card className="gap-0 py-0">
        {error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={error} />
          </div>
        ) : null}

        <Table aria-label={t("suppliers.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
              <TableHead>{t("suppliers.city")}</TableHead>
              <TableHead>{t("suppliers.country")}</TableHead>
              <TableHead>{t("suppliers.categoriesLabel")}</TableHead>
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? <TableEmptyRow colSpan={5} message={t("suppliers.noSuppliers")} /> : null}
            {result?.items.map((supplier) => (
              <TableRow key={supplier.id}>
                <TableCell className="pl-4 font-medium">
                  <Link to={`/suppliers/${supplier.id}`} className="hover:underline">
                    {supplier.name}
                  </Link>
                </TableCell>
                <TableCell>{supplier.city ?? "—"}</TableCell>
                <TableCell>{supplier.country ?? "—"}</TableCell>
                <TableCell>
                  {supplier.categories.length === 0 ? (
                    "—"
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {supplier.categories.map((category) => (
                        <Badge key={category.id} variant="secondary">
                          {category.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="pr-4 text-right">
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
          <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
        ) : null}
      </Card>
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
