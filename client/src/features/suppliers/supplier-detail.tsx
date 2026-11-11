import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, errorMessage } from "../../api/client";
import type { Supplier } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { PageHeader } from "../../components/page-header";
import { ProductsPanel } from "../products/products-panel";
import { AssetsPanel } from "./assets-panel";
import { CatalogsPanel } from "./catalogs-panel";
import { CategoryEditor } from "./category-editor";
import { chipsFrom, toCategoryInputs, type CategoryChip } from "./category-chips";
import { SupplierForm } from "./supplier-form";

export type DetailTab = "details" | "categories" | "assets" | "catalogs" | "products";

interface SupplierDetailProps {
  supplierId: string;
  tab?: DetailTab;
  onTabChange?: (tab: DetailTab) => void;
  onBack: () => void;
  onDeleted: () => void;
}

interface DetailTabItem {
  id: DetailTab;
  labelKey: string;
}

const DETAIL_TABS: DetailTabItem[] = [
  { id: "details", labelKey: "suppliers.tabDetails" },
  { id: "categories", labelKey: "suppliers.categoriesLabel" },
  { id: "assets", labelKey: "suppliers.assets" },
  { id: "catalogs", labelKey: "suppliers.catalogs" },
  { id: "products", labelKey: "suppliers.products" },
];

export function SupplierDetail({
  supplierId,
  tab: controlledTab,
  onTabChange,
  onBack,
  onDeleted,
}: SupplierDetailProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role === "admin";
  const [error, setError] = useState<string | null>(null);
  const [internalTab, setInternalTab] = useState<DetailTab>("details");
  const tab = controlledTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const queryClient = useQueryClient();
  const supplierQuery = useQuery({
    queryKey: ["supplier", supplierId],
    queryFn: async () =>
      (await apiRequest<{ supplier: Supplier }>("GET", `/suppliers/${supplierId}`)).supplier,
  });
  const supplier = supplierQuery.data ?? null;

  function updateSupplier(updated: Supplier) {
    queryClient.setQueryData(["supplier", supplierId], updated);
    void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiRequest<void>("DELETE", `/suppliers/${supplierId}`);
      await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const currentTabLabel = t(DETAIL_TABS.find((item) => item.id === tab)?.labelKey ?? "suppliers.tabDetails");
  const supplierLabel = supplier?.name ?? t("suppliers.title");
  const breadcrumbItems =
    tab === "details"
      ? [{ label: "Suppliers", to: "/suppliers" }, { label: supplierLabel }]
      : [
          { label: "Suppliers", to: "/suppliers" },
          { label: supplierLabel, to: `/suppliers/${supplierId}` },
          { label: currentTabLabel },
        ];

  return (
    <>
      <PageHeader
        title={supplierLabel}
        breadcrumbs={breadcrumbItems}
        actions={
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft />
            {t("suppliers.backToSuppliers")}
          </Button>
        }
      />

      <ErrorAlert message={error ?? (supplierQuery.error ? errorMessage(supplierQuery.error) : null)} />

      {!supplier ? null : (
        <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)} className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList className="h-9">
              {DETAIL_TABS.map((item) => (
                <TabsTrigger key={item.id} value={item.id} className="px-3">
                  {t(item.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
            {isAdmin ? (
              <Button variant="destructive" size="lg" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t("suppliers.deleteSupplier")}
              </Button>
            ) : null}
          </div>

          <TabsContent value="details">
            {isAdmin && editing ? (
              <SupplierForm
                supplier={supplier}
                onCancel={() => setEditing(false)}
                onSaved={(updated) => {
                  updateSupplier(updated);
                  setEditing(false);
                }}
              />
            ) : (
              <Card className="gap-6 py-6">
                <CardHeader className="px-6">
                  <CardTitle>
                    <h2>{t("suppliers.address")}</h2>
                  </CardTitle>
                  {isAdmin ? (
                    <CardAction>
                      <Button variant="outline" onClick={() => setEditing(true)}>
                        <Pencil />
                        {t("suppliers.editDetails")}
                      </Button>
                    </CardAction>
                  ) : null}
                </CardHeader>
                <CardContent className="px-6">
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-4 text-sm">
                    <dt className="text-muted-foreground">{t("suppliers.street")}</dt>
                    <dd>{supplier.street ?? "—"}</dd>
                    <dt className="text-muted-foreground">{t("suppliers.city")}</dt>
                    <dd>{supplier.city ?? "—"}</dd>
                    <dt className="text-muted-foreground">{t("suppliers.stateRegion")}</dt>
                    <dd>{supplier.stateRegion ?? "—"}</dd>
                    <dt className="text-muted-foreground">{t("suppliers.postalCode")}</dt>
                    <dd>{supplier.postalCode ?? "—"}</dd>
                    <dt className="text-muted-foreground">{t("suppliers.country")}</dt>
                    <dd>{supplier.country ?? "—"}</dd>
                  </dl>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="categories">
            <CategoriesTab supplier={supplier} isAdmin={isAdmin} onSaved={updateSupplier} onError={setError} />
          </TabsContent>

          <TabsContent value="assets">
            <AssetsPanel supplierId={supplier.id} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="catalogs">
            <CatalogsPanel supplierId={supplier.id} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="products">
            <ProductsPanel supplierId={supplier.id} isAdmin={isAdmin} />
          </TabsContent>
        </Tabs>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${supplier?.name ?? "supplier"}?`}
        description={t("suppliers.confirmDeleteDescription")}
        confirmLabel={t("suppliers.deleteSupplier")}
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

interface CategoriesTabProps {
  supplier: Supplier;
  isAdmin: boolean;
  onSaved: (supplier: Supplier) => void;
  onError: (message: string) => void;
}

function CategoriesTab({ supplier, isAdmin, onSaved, onError }: CategoriesTabProps) {
  const [chips, setChips] = useState<CategoryChip[]>(chipsFrom(supplier.categories));
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(chips) !== JSON.stringify(chipsFrom(supplier.categories));

  async function save() {
    setSaving(true);
    try {
      const result = await apiRequest<{ supplier: Supplier }>("PUT", `/suppliers/${supplier.id}`, {
        name: supplier.name,
        street: supplier.street,
        city: supplier.city,
        stateRegion: supplier.stateRegion,
        postalCode: supplier.postalCode,
        country: supplier.country,
        categories: toCategoryInputs(chips),
      });
      onSaved(result.supplier);
      setChips(chipsFrom(result.supplier.categories));
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-6 py-6">
      <CardHeader className="px-6">
        <CardTitle>
          <h2>{t("suppliers.categoriesLabel")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-6">
        <CategoryEditor value={chips} onChange={setChips} disabled={!isAdmin} />
      </CardContent>
      {isAdmin ? (
        <CardFooter className="justify-end border-t px-6 py-4">
          <Button size="lg" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? t("common.saving") : t("suppliers.saveCategories")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
