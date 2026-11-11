import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import { formatDate, formatMoney } from "../../api/format";
import type { Page, ProductDetail, ProductSummary, Supplier } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert, SuccessAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { SelectField } from "../../components/select-field";
import { TableEmptyRow } from "../../components/table-empty-row";
import { ProductForm } from "./product-form";

const PAGE_SIZE = 25;

interface ProductsPanelProps {
  /** When set, the panel lists only this supplier's products and creates new ones for it. */
  supplierId?: string;
  isAdmin: boolean;
}

/** Product list with search and pagination, plus create, edit, and delete for admins (FR-PRD-01..09). */
export function ProductsPanel({ supplierId, isAdmin }: ProductsPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<ProductSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductDetail | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProductSummary | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const effectiveSupplier = supplierId ?? supplierFilter ?? undefined;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    if (effectiveSupplier) params.set("supplierId", effectiveSupplier);
    try {
      setResult(await apiRequest<Page<ProductSummary>>("GET", `/products?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [page, search, effectiveSupplier]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (supplierId) return;
    apiRequest<Page<Supplier>>("GET", "/suppliers?pageSize=100")
      .then((response) => setSuppliers(response.items))
      .catch(() => undefined);
  }, [supplierId]);

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiRequest<void>("DELETE", `/products/${target.id}`);
      setStatus(`${localize(target.name)} was deleted.`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openEdit(summary: ProductSummary) {
    try {
      const response = await apiRequest<{ product: ProductDetail }>("GET", `/products/${summary.id}`);
      setEditing(response.product);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const columnCount = (supplierId ? 6 : 7) + (isAdmin ? 1 : 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
        <h2 className="text-base font-semibold">{supplierId ? "Products" : "All products"}</h2>
        {isAdmin ? (
          <Button size="lg" onClick={() => setEditing("new")}>
            <Plus />
            {t("products.createProduct")}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 py-1">
        <SearchForm
          label={t("products.searchLabel")}
          placeholder={t("products.searchPlaceholder")}
          value={query}
          onChange={setQuery}
          onSearch={() => {
            setPage(1);
            setSearch(query.trim());
          }}
        />
        {supplierId ? null : (
          <div className="w-56">
            <SelectField
              label="Supplier"
              hideLabel
              placeholder={t("products.allSuppliers")}
              options={[{ value: "", label: t("products.allSuppliers") }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]}
              value={supplierFilter ?? ""}
              onChange={(value) => {
                setPage(1);
                setSupplierFilter(value || null);
              }}
            />
          </div>
        )}
      </div>

      <Card className="gap-0 py-0">

      {error || status ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <ErrorAlert message={error} />
          {status ? <SuccessAlert message={status} /> : null}
        </div>
      ) : null}

      <Table aria-label={supplierId ? "Products" : "All products"}>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
            <TableHead>{t("products.skuLabel")}</TableHead>
            {supplierId ? null : <TableHead>{t("products.supplier")}</TableHead>}
            <TableHead className="text-right">{t("products.minQty")}</TableHead>
            <TableHead className="text-right">{t("products.cost")}</TableHead>
            <TableHead>{t("products.attributeSet")}</TableHead>
            <TableHead>{t("products.updated")}</TableHead>
            {isAdmin ? <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result && result.items.length === 0 ? <TableEmptyRow colSpan={columnCount} message="No products found." /> : null}
          {result?.items.map((product) => (
            <TableRow key={product.id}>
              <TableCell className="pl-4 font-medium">{localize(product.name)}</TableCell>
              <TableCell className="font-mono text-xs">{product.supplierSku}</TableCell>
              {supplierId ? null : <TableCell>{product.supplierName}</TableCell>}
              <TableCell className="text-right tabular-nums">{product.minQuantity}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(product.cost, product.currency)}</TableCell>
              <TableCell>
                {product.attributeSet ? <Badge variant="info">{localize(product.attributeSet.name)}</Badge> : "—"}
              </TableCell>
              <TableCell>{formatDate(product.updatedAt)}</TableCell>
              {isAdmin ? (
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <IconAction label={t("products.editAria", { name: localize(product.name) })} icon={Pencil} onClick={() => void openEdit(product)} />
                    <IconAction
                      label={t("products.deleteAria", { name: localize(product.name) })}
                      icon={Trash2}
                      destructive
                      onClick={() => setDeleting(product)}
                    />
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {result ? <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} /> : null}
      </Card>

      {editing ? (
        <ProductForm
          product={editing === "new" ? undefined : editing}
          defaultSupplierId={supplierId ?? supplierFilter ?? undefined}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setStatus(`${localize(saved.name)} was saved.`);
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t("products.confirmDeleteTitle", { name: deleting ? localize(deleting.name) : t("products.title") })}
        description={t("products.confirmDeleteDescription")}
        confirmLabel={t("products.deleteProduct")}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
