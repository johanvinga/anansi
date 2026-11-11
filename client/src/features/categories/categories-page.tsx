import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PageLayout } from "../../components/page-layout";
import { SearchForm } from "../../components/search-form";
import { TableEmptyRow } from "../../components/table-empty-row";

export function CategoriesPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({
    queryKey: ["categories", { search }],
    queryFn: async () => {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      return (await apiRequest<{ items: Category[] }>("GET", `/categories${params}`)).items;
    },
  });
  const categories = categoriesQuery.data ?? [];
  const loaded = categoriesQuery.isSuccess;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["categories"] });

  async function handleCategoryCreated() {
    setCreateOpen(false);
    await refresh();
    await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    await queryClient.invalidateQueries({ queryKey: ["catalogs"] });
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await apiRequest<void>("DELETE", `/categories/${target.id}`);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      await queryClient.invalidateQueries({ queryKey: ["catalogs"] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const columns = isAdmin ? 3 : 2;

  return (
    <>
      <PageLayout
        title={t("categories.title")}
        breadcrumbs={[{ label: t("categories.title") }]}
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
              <Button className="ml-auto" size="lg" onClick={() => setCreateOpen(true)}>
                <Plus />
                {t("categories.addCategory")}
              </Button>
            ) : null}
          </>
        }
      >
        {error || categoriesQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={error ?? (categoriesQuery.error ? errorMessage(categoriesQuery.error) : null)} />
          </div>
        ) : null}

        <Table aria-label={t("categories.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
              <TableHead>{t("categories.created")}</TableHead>
              {isAdmin ? <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loaded && categories.length === 0 ? <TableEmptyRow colSpan={columns} message={t("categories.noCategories")} /> : null}
            {categories.map((category) => (
              <TableRow key={category.id}>
                <TableCell className="pl-4 font-medium">{localize(category.name)}</TableCell>
                <TableCell>{new Date(category.createdAt).toLocaleDateString()}</TableCell>
                {isAdmin ? (
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <IconAction label={t("categories.renameAria", { name: localize(category.name) })} icon={Pencil} onClick={() => setRenaming(category)} />
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
            void refresh();
            void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
            void queryClient.invalidateQueries({ queryKey: ["catalogs"] });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t("categories.confirmDeleteTitle", { name: deleting ? localize(deleting.name) : t("categories.title") })}
        description={t("categories.confirmDeleteDescription")}
        confirmLabel={t("categories.deleteCategory")}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

interface CreateCategoryDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

function CreateCategoryDialog({ onClose, onCreated }: CreateCategoryDialogProps) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState("");
  const [nameFr, setNameFr] = useState("");
  const [nameFrEdited, setNameFrEdited] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function changeEnglishName(value: string) {
    setNameEn(value);
    if (!nameFrEdited) setNameFr(value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("POST", "/categories", { name: { en: nameEn, fr: nameFr } });
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
            <Button type="submit" disabled={submitting || !nameEn.trim() || !nameFr.trim()}>
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
  const [name, setName] = useState(localize(category.name));
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Keeps the stored French name until the bilingual rename dialog lands (SPEC FR-I18N-04).
      await apiRequest("PUT", `/categories/${category.id}`, { name: { en: name, fr: category.name.fr } });
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
            <FormField label={t("suppliers.name")} name="name" value={name} onChange={setName} required error={error?.fieldError("name")} />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
