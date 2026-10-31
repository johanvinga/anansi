import { Tabs } from "@ark-ui/react/tabs";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, errorMessage } from "../../api/client";
import type { Supplier } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { AssetsPanel } from "./assets-panel";
import { CategoryEditor } from "./category-editor";
import { chipsFrom, toCategoryInputs, type CategoryChip } from "./category-chips";
import { SupplierForm } from "./supplier-form";

interface SupplierDetailProps {
  supplierId: string;
  onBack: () => void;
  onDeleted: () => void;
}

type DetailTab = "details" | "categories" | "assets" | "products";

export function SupplierDetail({ supplierId, onBack, onDeleted }: SupplierDetailProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("details");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiRequest<{ supplier: Supplier }>("GET", `/suppliers/${supplierId}`);
      setSupplier(result.supplier);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [supplierId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiRequest<void>("DELETE", `/suppliers/${supplierId}`);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="page">
      <div className="page-header">
        <button type="button" className="secondary-button" onClick={onBack}>
          ← Back to suppliers
        </button>
        {isAdmin && supplier ? (
          <button type="button" className="danger-button" onClick={() => setConfirmDelete(true)}>
            Delete supplier
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {!supplier ? null : (
        <>
          <h1>{supplier.name}</h1>
          <Tabs.Root className="tabs" value={tab} onValueChange={(details) => setTab(details.value as DetailTab)} lazyMount unmountOnExit>
            <Tabs.List className="tab-list">
              <Tabs.Trigger value="details">Details</Tabs.Trigger>
              <Tabs.Trigger value="categories">Categories</Tabs.Trigger>
              <Tabs.Trigger value="assets">Assets</Tabs.Trigger>
              <Tabs.Trigger value="products">Products</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="details">
              {isAdmin && editing ? (
                <SupplierForm
                  supplier={supplier}
                  onCancel={() => setEditing(false)}
                  onSaved={(updated) => {
                    setSupplier(updated);
                    setEditing(false);
                  }}
                />
              ) : (
                <div className="card">
                  <dl className="profile">
                    <dt>Street</dt>
                    <dd>{supplier.street ?? "—"}</dd>
                    <dt>City</dt>
                    <dd>{supplier.city ?? "—"}</dd>
                    <dt>State / region</dt>
                    <dd>{supplier.stateRegion ?? "—"}</dd>
                    <dt>Postal code</dt>
                    <dd>{supplier.postalCode ?? "—"}</dd>
                    <dt>Country</dt>
                    <dd>{supplier.country ?? "—"}</dd>
                  </dl>
                  {isAdmin ? (
                    <button type="button" className="primary-button" onClick={() => setEditing(true)}>
                      Edit details
                    </button>
                  ) : null}
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content value="categories">
              <CategoriesTab supplier={supplier} isAdmin={isAdmin} onSaved={setSupplier} onError={setError} />
            </Tabs.Content>

            <Tabs.Content value="assets">
              <AssetsPanel supplierId={supplier.id} isAdmin={isAdmin} />
            </Tabs.Content>

            <Tabs.Content value="products">
              <div className="card">
                <p>Products for this supplier will appear here once product management is available.</p>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${supplier?.name ?? "supplier"}?`}
        description="The supplier and all of its uploaded files will be permanently deleted. This cannot be undone."
        confirmLabel="Delete supplier"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
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
    <div className="card">
      <CategoryEditor value={chips} onChange={setChips} disabled={!isAdmin} />
      {isAdmin ? (
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save categories"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
