import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { Category } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";

export function CategoriesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const newCategoryId = useId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
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

  const columns = isAdmin ? 3 : 2;

  return (
    <>
      <PageHeader title="Categories" breadcrumbs={[{ label: "Categories" }]} />

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <SearchForm
            label="Search categories"
            placeholder="Search categories…"
            value={query}
            onChange={setQuery}
            onSearch={() => setSearch(query.trim())}
          />
          {isAdmin ? (
            <form className="flex items-center gap-2" onSubmit={(event) => void createCategory(event)} noValidate>
              <Label htmlFor={newCategoryId} className="sr-only">
                New category
              </Label>
              <Input
                id={newCategoryId}
                name="newCategory"
                placeholder="New category"
                required
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                className="w-48"
              />
              <Button type="submit" size="lg" disabled={creating || !newName.trim()}>
                <Plus />
                Add category
              </Button>
            </form>
          ) : null}
        </div>

        {error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={error} />
          </div>
        ) : null}

        <Table aria-label="Categories">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Created</TableHead>
              {isAdmin ? <TableHead className="pr-4 text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loaded && categories.length === 0 ? <TableEmptyRow colSpan={columns} message="No categories found." /> : null}
            {categories.map((category) => (
              <TableRow key={category.id}>
                <TableCell className="pl-4 font-medium">{category.name}</TableCell>
                <TableCell>{new Date(category.createdAt).toLocaleDateString()}</TableCell>
                {isAdmin ? (
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <IconAction label={`Rename ${category.name}`} icon={Pencil} onClick={() => setRenaming(category)} />
                      <IconAction
                        label={`Delete ${category.name}`}
                        icon={Trash2}
                        destructive
                        onClick={() => setDeleting(category)}
                      />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

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
    </>
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
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Rename category</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <FormField label="Name" name="name" value={name} onChange={setName} required error={error?.fieldError("name")} />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
