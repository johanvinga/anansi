import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiRequest, errorMessage } from "../../api/client";
import type { Page, Supplier } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { FormField } from "../../components/form-field";
import { PaginationControls } from "../../components/pagination-controls";
import { SupplierDetail } from "./supplier-detail";
import { SupplierForm } from "./supplier-form";

const PAGE_SIZE = 25;

export function SuppliersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<Supplier> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
    if (!selectedId && !creating) {
      void load();
    }
  }, [load, selectedId, creating]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(query.trim());
  }

  if (creating) {
    return (
      <section className="page">
        <h1>New supplier</h1>
        <SupplierForm
          onCancel={() => setCreating(false)}
          onSaved={(supplier) => {
            setCreating(false);
            setSelectedId(supplier.id);
          }}
        />
      </section>
    );
  }

  if (selectedId) {
    return (
      <SupplierDetail
        supplierId={selectedId}
        onBack={() => setSelectedId(null)}
        onDeleted={() => {
          setSelectedId(null);
          setPage(1);
        }}
      />
    );
  }

  return (
    <section className="page">
      <div className="page-header">
        <h1>Suppliers</h1>
        {isAdmin ? (
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            New supplier
          </button>
        ) : null}
      </div>

      <form className="toolbar" onSubmit={handleSearch} role="search">
        <FormField label="Search by name" name="q" value={query} onChange={setQuery} />
        <button type="submit" className="secondary-button">
          Search
        </button>
      </form>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">City</th>
            <th scope="col">Country</th>
            <th scope="col">Categories</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {result?.items.length === 0 ? (
            <tr>
              <td colSpan={5}>No suppliers found.</td>
            </tr>
          ) : null}
          {result?.items.map((supplier) => (
            <tr key={supplier.id}>
              <td>{supplier.name}</td>
              <td>{supplier.city ?? "—"}</td>
              <td>{supplier.country ?? "—"}</td>
              <td>{supplier.categories.map((c) => c.name).join(", ") || "—"}</td>
              <td>
                <button type="button" className="secondary-button" onClick={() => setSelectedId(supplier.id)}>
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {result ? (
        <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
      ) : null}
    </section>
  );
}
