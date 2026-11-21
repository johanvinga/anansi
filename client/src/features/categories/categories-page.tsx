import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderInput, Pencil, Plus, Trash2 } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { Category } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PageLayout } from "../../components/page-layout";
import { SearchForm } from "../../components/search-form";
import { SelectField } from "../../components/select-field";
import { TableEmptyRow } from "../../components/table-empty-row";

export function CategoriesPage() {
  const { categoryId } = useParams<{ categoryId: string }>();
  return <CategoryDirectory key={categoryId ?? "root"} categoryId={categoryId} />;
}

interface CategoryDirectoryProps {
  categoryId?: string;
}

function CategoryDirectory({ categoryId }: CategoryDirectoryProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<Category | null>(null);
  const [moving, setMoving] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await apiRequest<{ items: Category[] }>("GET", "/categories")).items,
  });
  const allCategories = categoriesQuery.data ?? [];
  const loaded = categoriesQuery.isSuccess;
  const currentCategory = allCategories.find((category) => category.id === categoryId);
  const needle = search.toLocaleLowerCase();
  const categories = needle
    ? allCategories.filter((category) =>
        category.name.en.toLocaleLowerCase().includes(needle)
        || category.name.fr.toLocaleLowerCase().includes(needle)
      )
    : allCategories.filter((category) => category.parentId === (categoryId ?? null));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["categories"] });

  async function handleCategoryCreated() {
    setCreateOpen(false);
    await refresh();
    await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    await queryClient.invalidateQueries({ queryKey: ["catalogs"] });
  }

  const refreshRelated = () => {
    void refresh();
    void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    void queryClient.invalidateQueries({ queryKey: ["supplier"] });
    void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
    void queryClient.invalidateQueries({ queryKey: ["products"] });
  };
  const columns = isAdmin ? 4 : 3;
  const title = currentCategory ? localize(currentCategory.name) : t("categories.title");
  const breadcrumbs = [
    { label: t("categories.title"), to: categoryId ? "/categories" : undefined },
    ...(currentCategory?.path.map((part, index, path) => ({
      label: localize(part.name),
      to: index < path.length - 1 ? `/categories/${part.id}` : undefined,
    })) ?? []),
  ];

  if (loaded && categoryId && !currentCategory) {
    return <Navigate to="/categories" replace />;
  }

  return (
    <>
      <PageLayout
        title={title}
        breadcrumbs={breadcrumbs}
        toolbar={
          <>
            <SearchForm
              label={t("categories.searchLabel")}
              placeholder={t("categories.searchPlaceholder")}
              value={query}
              onChange={setQuery}
              onSearch={() => setSearch(query.trim())}
            />
            {isAdmin ? (
              <div className="ml-auto flex items-center gap-1">
                {currentCategory ? (
                  <>
                    <IconAction label={t("categories.renameAria", { name: localize(currentCategory.name) })} icon={Pencil} onClick={() => setRenaming(currentCategory)} />
                    <IconAction label={t("categories.moveAria", { name: localize(currentCategory.name) })} icon={FolderInput} onClick={() => setMoving(currentCategory)} />
                    <IconAction
                      label={t("suppliers.deleteAria", { name: localize(currentCategory.name) })}
                      icon={Trash2}
                      destructive
                      onClick={() => setDeleting(currentCategory)}
                    />
                  </>
                ) : null}
                <Button size="lg" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  {t("categories.addCategory")}
                </Button>
              </div>
            ) : null}
          </>
        }
      >
        {categoriesQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={errorMessage(categoriesQuery.error)} />
          </div>
        ) : null}

        <Table aria-label={t("categories.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
              <TableHead>{t("categories.parent")}</TableHead>
              <TableHead>{t("categories.created")}</TableHead>
              {isAdmin ? <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loaded && categories.length === 0 ? (
              <TableEmptyRow
                colSpan={columns}
                message={t(currentCategory && !search ? "categories.noChildCategories" : "categories.noCategories")}
              />
            ) : null}
            {categories.map((category) => (
              <TableRow key={category.id}>
                <TableCell className="pl-4 font-medium">
                  <Link className="inline-flex items-center gap-1 hover:underline" to={`/categories/${category.id}`}>
                    {localize(category.name)}
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </TableCell>
                <TableCell>{category.path.length > 1 ? category.path.slice(0, -1).map((part) => localize(part.name)).join(" / ") : t("categories.root")}</TableCell>
                <TableCell>{new Date(category.createdAt).toLocaleDateString()}</TableCell>
                {isAdmin ? (
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <IconAction label={t("categories.renameAria", { name: localize(category.name) })} icon={Pencil} onClick={() => setRenaming(category)} />
                      <IconAction label={t("categories.moveAria", { name: localize(category.name) })} icon={FolderInput} onClick={() => setMoving(category)} />
                      <IconAction
                        label={t("suppliers.deleteAria", { name: localize(category.name) })}
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
      </PageLayout>

      {createOpen ? (
        <CreateCategoryDialog
          parentId={categoryId ?? null}
          onClose={() => setCreateOpen(false)}
          onCreated={() => void handleCategoryCreated()}
        />
      ) : null}

      {renaming ? (
        <RenameCategoryDialog
          category={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            refreshRelated();
          }}
        />
      ) : null}

      {moving ? <MoveCategoryDialog category={moving} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); refreshRelated(); }} /> : null}
      {deleting ? (
        <DeleteCategoryDialog
          category={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const deletedCurrent = deleting.id === categoryId;
            const parentId = deleting.parentId;
            setDeleting(null);
            refreshRelated();
            if (deletedCurrent) navigate(parentId ? `/categories/${parentId}` : "/categories", { replace: true });
          }}
        />
      ) : null}
    </>
  );
}

interface CreateCategoryDialogProps {
  parentId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

function CreateCategoryDialog({ parentId, onClose, onCreated }: CreateCategoryDialogProps) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState("");
  const [nameFr, setNameFr] = useState("");
  const [nameFrEdited, setNameFrEdited] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [parent, setParent] = useState<string | null>(parentId ?? "__root__");
  const categories = useAllCategories();

  function changeEnglishName(value: string) {
    setNameEn(value);
    if (!nameFrEdited) setNameFr(value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("POST", "/categories", { name: { en: nameEn, fr: nameFr }, parentId: parent === "__root__" ? null : parent });
      onCreated();
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
            <DialogTitle>{t("categories.createCategoryTitle")}</DialogTitle>
            <DialogDescription>{t("categories.createCategoryDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <FormField
              label={t("common.nameEnglish")}
              name="name.en"
              value={nameEn}
              onChange={changeEnglishName}
              required
              error={error?.fieldError("name.en")}
              maxLength={100}
            />
            {categories.isError ? <><ErrorAlert message={errorMessage(categories.error)} /><Button type="button" variant="outline" onClick={() => void categories.refetch()}>{t("categories.filterRetry")}</Button></> : null}
            <SelectField label={t("categories.parent")} value={parent} onChange={setParent} required error={error?.fieldError("parentId")}
              options={[{ value: "__root__", label: t("categories.root") }, ...(categories.data ?? []).map((category) => ({ value: category.id, label: category.path.map((part) => localize(part.name)).join(" / ") }))]} />
            <FormField
              label={t("common.nameFrench")}
              name="name.fr"
              value={nameFr}
              onChange={(value) => {
                setNameFr(value);
                setNameFrEdited(true);
              }}
              required
              error={error?.fieldError("name.fr")}
              maxLength={100}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || !nameEn.trim() || !nameFr.trim() || parent === null || !categories.isSuccess}>
              {submitting ? t("common.saving") : t("categories.addCategory")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface RenameCategoryDialogProps {
  category: Category;
  onClose: () => void;
  onRenamed: () => void;
}

function RenameCategoryDialog({ category, onClose, onRenamed }: RenameCategoryDialogProps) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState(category.name.en);
  const [nameFr, setNameFr] = useState(category.name.fr);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("PUT", `/categories/${category.id}`, { name: { en: nameEn, fr: nameFr } });
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
            <DialogTitle>{t("categories.renameCategory")}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <FormField label={t("common.nameEnglish")} name="name.en" value={nameEn} onChange={setNameEn} required error={error?.fieldError("name.en")} />
            <FormField label={t("common.nameFrench")} name="name.fr" value={nameFr} onChange={setNameFr} required error={error?.fieldError("name.fr")} />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || !nameEn.trim() || !nameFr.trim()}>
              {submitting ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useAllCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await apiRequest<{ items: Category[] }>("GET", "/categories")).items,
  });
}

interface CategoryActionProps {
  category: Category;
  onClose: () => void;
}

function MoveCategoryDialog({ category, onClose, onSaved }: CategoryActionProps & { onSaved: () => void }) {
  const { t } = useTranslation();
  const categories = useAllCategories();
  const [parent, setParent] = useState(category.parentId ?? "__root__");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiRequest("PUT", `/categories/${category.id}`, { parentId: parent === "__root__" ? null : parent });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit} className="flex flex-col gap-6">
        <DialogHeader><DialogTitle>{t("categories.moveTitle", { name: localize(category.name) })}</DialogTitle>
          <DialogDescription>{t("categories.moveDescription")}</DialogDescription></DialogHeader>
        <ErrorAlert message={error ?? (categories.error ? errorMessage(categories.error) : null)} />
        <SelectField label={t("categories.parent")} value={parent} onChange={(value) => setParent(value ?? "__root__")} required
          options={[{ value: "__root__", label: t("categories.root") }, ...(categories.data ?? [])
            .filter((item) => !item.path.some((part) => part.id === category.id))
            .map((item) => ({ value: item.id, label: item.path.map((part) => localize(part.name)).join(" / ") }))]} />
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !categories.isSuccess}>{busy ? t("common.saving") : t("common.save")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

interface DeletionImpact {
  products: number;
  suppliers: number;
  catalogs: number;
  uncategorizedProducts: number;
  children: number;
}

function DeleteCategoryDialog({ category, onClose, onDeleted }: CategoryActionProps & { onDeleted: () => void }) {
  const { t } = useTranslation();
  const categories = useAllCategories();
  const impact = useQuery({
    queryKey: ["categories", category.id, "deletion-impact"],
    queryFn: () => apiRequest<DeletionImpact>("GET", `/categories/${category.id}/deletion-impact`),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("DELETE", `/categories/${category.id}`);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      void impact.refetch();
    } finally {
      setBusy(false);
    }
  }
  const children = (categories.data ?? []).filter((item) => item.parentId === category.id);
  const destination = category.path.length > 1 ? category.path.slice(0, -1).map((part) => localize(part.name)).join(" / ") : t("categories.root");
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t("categories.confirmDeleteTitle", { name: localize(category.name) })}</DialogTitle>
        <DialogDescription>{t("categories.confirmDeleteDescription")}</DialogDescription></DialogHeader>
      <ErrorAlert message={error ?? (impact.error ? errorMessage(impact.error) : categories.error ? errorMessage(categories.error) : null)} />
      {impact.isLoading || categories.isLoading ? <p role="status">{t("common.loading")}</p> : null}
      {impact.isError || categories.isError ? <Button type="button" variant="outline" onClick={() => { void impact.refetch(); void categories.refetch(); }}>{t("categories.filterRetry")}</Button> : null}
      {impact.data && categories.isSuccess ? <div className="space-y-2 text-sm">
        <p>{t("categories.deleteCounts", { products: impact.data.products, suppliers: impact.data.suppliers, catalogs: impact.data.catalogs })}</p>
        <p>{t("categories.deleteUncategorized", { count: impact.data.uncategorizedProducts })}</p>
        <p>{t("categories.deleteChildren", { count: impact.data.children, destination })}</p>
        {children.length ? <ul className="list-disc pl-5">{children.map((child) => <li key={child.id}>{localize(child.name)}</li>)}</ul> : null}
      </div> : null}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="button" variant="destructive" disabled={busy || !impact.isSuccess || !categories.isSuccess || impact.isFetching} onClick={() => void remove()}>{t("categories.deleteCategory")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
