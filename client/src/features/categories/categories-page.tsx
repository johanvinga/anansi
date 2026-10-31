import { Dialog } from "@ark-ui/react/dialog";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { Category } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { FormField } from "../../components/form-field";

export function CategoriesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const load = useCallback(async () => {
    const params = search ? `?q=${encodeURIComponent(search)}` : "";
    try {
      const result = await apiRequest<{ items: Category[] }>("GET", `/categories${params}`);
      setCategories(result.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    try {
      await apiRequest("POST", "/categories", { name: newName });
      setNewName("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiRequest<void>("DELETE", `/categories/${target.id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="page">
      <h1>Categories</h1>

      {isAdmin ? (
        <form className="toolbar" onSubmit={(event) => void createCategory(event)} noValidate>
          <FormField label="New category" name="newCategory" value={newName} onChange={setNewName} required />
          <button type="submit" className="primary-button" disabled={creating || !newName.trim()}>
            Add category
          </button>
        </form>
      ) : null}

      <form
        className="toolbar"
        role="search"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          setSearch(query.trim());
        }}
      >
        <FormField label="Search categories" name="q" value={query} onChange={setQuery} />
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
            <th scope="col">Created</th>
            {isAdmin ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {categories.length === 0 ? (
            <tr>
              <td colSpan={isAdmin ? 3 : 2}>No categories found.</td>
            </tr>
          ) : null}
          {categories.map((category) => (
            <tr key={category.id}>
              <td>{category.name}</td>
              <td>{new Date(category.createdAt).toLocaleDateString()}</td>
              {isAdmin ? (
                <td className="row-actions">
                  <button type="button" className="secondary-button" onClick={() => setRenaming(category)}>
                    Rename
                  </button>
                  <button type="button" className="danger-button" onClick={() => setDeleting(category)}>
                    Delete
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {renaming ? (
        <RenameCategoryDialog
          category={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? "category"}?`}
        description="The category is removed from every supplier that uses it. The suppliers themselves are kept."
        confirmLabel="Delete category"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}

interface RenameCategoryDialogProps {
  category: Category;
  onClose: () => void;
  onRenamed: () => void;
}

function RenameCategoryDialog({ category, onClose, onRenamed }: RenameCategoryDialogProps) {
  const [name, setName] = useState(category.name);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("PUT", `/categories/${category.id}`, { name });
      onRenamed();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(details) => !details.open && onClose()}>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Positioner className="dialog-positioner">
        <Dialog.Content className="card dialog">
          <form onSubmit={handleSubmit} noValidate>
            <Dialog.Title>Rename category</Dialog.Title>
            {error && error.details.length === 0 ? (
              <p role="alert" className="form-error">
                {error.message}
              </p>
            ) : null}
            <FormField label="Name" name="name" value={name} onChange={setName} required error={error?.fieldError("name")} />
            <div className="dialog-actions">
              <Dialog.CloseTrigger className="secondary-button">Cancel</Dialog.CloseTrigger>
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
