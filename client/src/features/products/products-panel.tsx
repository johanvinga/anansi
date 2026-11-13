import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import { formatDate, formatMoney } from "../../api/format";
import type { Page, ProductDetail, ProductSummary, Supplier } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert, SuccessAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PageLayout } from "../../components/page-layout";
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
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductDetail | "new" | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProductSummary | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const effectiveSupplier = supplierId ?? supplierFilter ?? undefined;
  const productsQuery = useQuery({
    queryKey: ["products", { page, pageSize: PAGE_SIZE, search, supplierId: effectiveSupplier }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search) params.set("q", search);
      if (effectiveSupplier) params.set("supplierId", effectiveSupplier);
      return apiRequest<Page<ProductSummary>>("GET", `/products?${params.toString()}`);
    },
  });
  const suppliersQuery = useQuery({
    queryKey: ["suppliers", "picker", 100],
    enabled: !supplierId,
    queryFn: async () =>
      (await apiRequest<Page<Supplier>>("GET", "/suppliers?pageSize=100")).items,
  });
  const detailQuery = useQuery({
    queryKey: ["product", viewingId],
    enabled: viewingId !== null,
    queryFn: async () =>
      (await apiRequest<{ product: ProductDetail }>("GET", `/products/${viewingId}`)).product,
  });
  const result = productsQuery.data;
  const suppliers = suppliersQuery.data ?? [];
  const viewing = detailQuery.data;

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiRequest<void>("DELETE", `/products/${target.id}`);
      setStatus(`${localize(target.name)} was deleted.`);
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      await queryClient.invalidateQueries({ queryKey: ["supplier"] });
      await queryClient.invalidateQueries({ queryKey: ["catalogs"] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openEdit(summary: ProductSummary) {
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ["product", summary.id],
        queryFn: async () =>
          (await apiRequest<{ product: ProductDetail }>("GET", `/products/${summary.id}`)).product,
      });
      setEditing(detail);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const localizedDescription = viewing
    ? localize({ en: viewing.description.en ?? "", fr: viewing.description.fr ?? "" })
    : "";
  const columnCount = (supplierId ? 6 : 7) + (isAdmin ? 1 : 0);
  const pageTitle = supplierId ? undefined : t("products.title");

  return (
    <>
      <PageLayout
        title={pageTitle}
        breadcrumbs={pageTitle ? [{ label: pageTitle }] : undefined}
        toolbar={
          <>
            <div className="flex flex-row items-center gap-3">
              {supplierId ? <h2 className="text-base font-semibold">{t("products.title")}</h2> : null}
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
            {isAdmin ? (
              <Button size="lg" onClick={() => setEditing("new")}>
                <Plus />
                {t("products.createProduct")}
              </Button>
            ) : null}
          </>
        }
      >
        {error || status || productsQuery.error || suppliersQuery.error ? (
          <div className="flex flex-col gap-2 px-4 pb-4">
            <ErrorAlert message={error ?? (productsQuery.error ? errorMessage(productsQuery.error) : suppliersQuery.error ? errorMessage(suppliersQuery.error) : null)} />
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
                <TableCell className="pl-4">
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 font-medium text-foreground"
                    aria-label={t("products.viewAria", { name: localize(product.name) })}
                    onClick={() => setViewingId(product.id)}
                  >
                    {localize(product.name)}
                  </Button>
                </TableCell>
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
      </PageLayout>

      {editing ? (
        <ProductForm
          product={editing === "new" ? undefined : editing}
          defaultSupplierId={supplierId ?? supplierFilter ?? undefined}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setStatus(`${localize(saved.name)} was saved.`);
            void queryClient.invalidateQueries({ queryKey: ["products"] });
            void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
            void queryClient.invalidateQueries({ queryKey: ["supplier"] });
            void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
            queryClient.setQueryData(["product", saved.id], saved);
          }}
        />
      ) : null}

      <Dialog open={viewingId !== null} onOpenChange={(open) => !open && setViewingId(null)}>
        {viewingId ? (
          <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{viewing ? localize(viewing.name) : t("common.loading")}</DialogTitle>
              <DialogDescription>{t("products.detailsSubtitle")}</DialogDescription>
            </DialogHeader>
            {!viewing && detailQuery.error ? <ErrorAlert message={errorMessage(detailQuery.error)} /> : null}
            {viewing ? (
              <>
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t("products.supplier")}</dt>
                    <dd className="font-medium">{viewing.supplierName}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("products.supplierSku")}</dt>
                    <dd className="font-mono text-sm">{viewing.supplierSku}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("categories.title")}</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {viewing.categories.length > 0
                        ? viewing.categories.map((category) => (
                            <Badge key={category.id} variant="secondary">{localize(category.name)}</Badge>
                          ))
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("products.minimumQuantity")}</dt>
                    <dd>{viewing.minQuantity}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("products.costLabel")}</dt>
                    <dd>{formatMoney(viewing.cost, viewing.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("products.attributeSet")}</dt>
                    <dd>{viewing.attributeSet ? localize(viewing.attributeSet.name) : "—"}</dd>
                  </div>
                </dl>
                <section className="space-y-2 border-t pt-4">
                  <h3 className="font-medium">{t("products.productDescription")}</h3>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {localizedDescription || t("products.noDescription")}
                  </p>
                </section>
              </>
            ) : null}
          </DialogContent>
        ) : null}
      </Dialog>

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
