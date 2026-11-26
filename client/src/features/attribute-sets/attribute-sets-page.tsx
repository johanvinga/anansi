import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Eye, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { AttributeDataType, AttributeField, AttributeSetDetail, AttributeSetSummary, Page } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { FormField } from "../../components/form-field";
import { ErrorAlert } from "../../components/error-alert";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { IconAction } from "../../components/icon-action";
import { PageBreadcrumbs } from "../../components/page-breadcrumbs";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { SelectField } from "../../components/select-field";
import { TableEmptyRow } from "../../components/table-empty-row";
import { usePagedList, usePageClamp } from "../../lib/use-paged-list";
import { AttributeSetBuilder } from "./attribute-set-builder";

export function AttributeSetsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [createOpen, setCreateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "sets" ? "sets" : "attributes";
  const setTab = (value: string) => setSearchParams(value === "sets" ? { tab: "sets" } : {});
  const queryClient = useQueryClient();

  return (
    <>
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={[{ label: t("attributes.title") }]} />
        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList>
            <TabsTrigger value="attributes">{t("attributes.title")}</TabsTrigger>
            <TabsTrigger value="sets">{t("attributeSets.title")}</TabsTrigger>
          </TabsList>
          <TabsContent value="attributes"><IndependentAttributes isAdmin={isAdmin} /></TabsContent>
            <TabsContent value="sets">
              {isAdmin ? (
                <div className="mb-4 flex justify-end">
                  <Button size="lg" onClick={() => setCreateOpen(true)}>
                    <Plus />
                    {t("attributeSets.createSetButton")}
                  </Button>
                </div>
              ) : null}
              <AttributeSetsTable isAdmin={isAdmin} />
            </TabsContent>
        </Tabs>
      </div>

      {createOpen ? (
        <CreateAttributeSetDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
            navigate(`/attribute-sets/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

interface AttributeSetsTableProps {
  isAdmin: boolean;
}

function AttributeSetsTable({ isAdmin }: AttributeSetsTableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const list = usePagedList();
  const { page, pageSize } = list;
  const setsQuery = useQuery({
    queryKey: ["attribute-sets", "page", { page, pageSize }],
    queryFn: () => apiRequest<Page<AttributeSetSummary>>("GET", `/attribute-sets?page=${page}&pageSize=${pageSize}`),
    placeholderData: keepPreviousData,
  });
  usePageClamp(list, setsQuery.data?.total);
  const sets = setsQuery.data?.items ?? [];

  return (
    <Card className="gap-0 py-0">
      {setsQuery.error ? (
        <div className="px-4 pb-4">
          <ErrorAlert message={errorMessage(setsQuery.error)} />
        </div>
      ) : null}

      <Table aria-label="Attribute sets">
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
            <TableHead className="text-right">{t("attributeSets.fields")}</TableHead>
            <TableHead className="text-right">{t("attributeSets.products")}</TableHead>
            <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {setsQuery.data && sets.length === 0 ? <TableEmptyRow colSpan={4} message="No attribute sets yet." /> : null}
          {sets.map((set) => (
            <TableRow key={set.id}>
              <TableCell className="pl-4 font-medium">
                <Link to={`/attribute-sets/${set.id}`} className="hover:underline">
                  {localize(set.name)}
                </Link>
              </TableCell>
              <TableCell className="text-right">
                <Badge variant="secondary">{set.fieldCount}</Badge>
              </TableCell>
              <TableCell className="text-right">
                <Badge variant={set.productCount > 0 ? "info" : "secondary"}>{set.productCount}</Badge>
              </TableCell>
              <TableCell className="pr-4 text-right">
                <IconAction
                  label={isAdmin ? `Open builder for ${localize(set.name)}` : `View ${localize(set.name)}`}
                  icon={isAdmin ? Settings2 : Eye}
                  onClick={() => navigate(`/attribute-sets/${set.id}`)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {setsQuery.data ? (
        <PaginationControls total={setsQuery.data.total} pageSize={pageSize} page={page} onPageChange={list.setPage} />
      ) : null}
    </Card>
  );
}

interface IndependentAttributesProps {
  isAdmin: boolean;
}

function IndependentAttributes({ isAdmin }: IndependentAttributesProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = usePagedList();
  const { search, page, pageSize } = list;
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [migrateConfirm, setMigrateConfirm] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{ migrated: { fieldId: string }[]; conflicts: { fieldId: string; setId: string; setName: string; name: string; reason: string }[] } | null>(null);
  const [nameEn, setNameEn] = useState("");
  const [nameFr, setNameFr] = useState("");
  const [dataType, setDataType] = useState<AttributeDataType>("text");
  const [unit, setUnit] = useState("");
  const [options, setOptions] = useState<string[]>([""]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const query = useQuery({
    queryKey: ["independent-attributes", "page", { page, pageSize, search }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set("q", search);
      return apiRequest<Page<AttributeField>>("GET", `/attributes?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });
  usePageClamp(list, query.data?.total);
  const attributes = query.data?.items ?? [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest(editing ? "PUT" : "POST", editing ? `/attributes/${editing}` : "/attributes", {
        name: { en: nameEn, fr: nameFr || nameEn },
        ...(!editing ? { dataType, unit: unit.trim() || null, options: dataType === "select" ? options.filter((option) => option.trim()).map((option) => ({ en: option })) : [] } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["independent-attributes"] });
      setOpen(false);
      setNameEn("");
      setNameFr("");
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setError(null);
    try {
      await apiRequest("DELETE", `/attributes/${removing.id}`);
      await queryClient.invalidateQueries({ queryKey: ["independent-attributes"] });
      setRemoving(null);
    } catch (err) {
      setError(errorMessage(err));
      setRemoving(null);
    }
  }
  async function migrateLegacy() {
    setMigrating(true);
    setError(null);
    try {
      const result = await apiRequest<{ migrated: { fieldId: string }[]; conflicts: { fieldId: string; setId: string; setName: string; name: string; reason: string }[] }>("POST", "/attributes/migrate-legacy");
      setMigrationResult(result);
      setMigrateConfirm(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["independent-attributes"] }),
        queryClient.invalidateQueries({ queryKey: ["attribute-sets"] }),
        queryClient.invalidateQueries({ queryKey: ["attribute-set"] }),
        queryClient.invalidateQueries({ queryKey: ["attribute-set-fields"] }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
      ]);
    } catch (err) {
      setError(errorMessage(err));
      setMigrateConfirm(false);
    } finally {
      setMigrating(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchForm
          label={t("attributes.searchLabel")}
          placeholder={t("attributes.searchPlaceholder")}
          value={list.searchInput}
          onChange={list.setSearchInput}
          onSearch={list.submitSearch}
        />
        {isAdmin ? <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={() => { setEditing(null); setNameEn(""); setNameFr(""); setDataType("text"); setUnit(""); setOptions([""]); setError(null); setOpen(true); }}><Plus />{t("attributes.create")}</Button>
          <Button size="lg" variant="outline" onClick={() => setMigrateConfirm(true)}>{t("attributes.migrateLegacy")}</Button>
        </div> : null}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t("attributes.description")}</p>
        <ErrorAlert message={!open ? error ?? (query.error ? errorMessage(query.error) : null) : null} />
      </div>
      <Card className="gap-0 py-0">
        <Table>
          <TableHeader className="bg-muted/50"><TableRow><TableHead className="pl-4">{t("suppliers.name")}</TableHead><TableHead>{t("attributeSets.dataType")}</TableHead>{isAdmin ? <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead> : null}</TableRow></TableHeader>
          <TableBody>
            {query.data && attributes.length === 0 ? <TableEmptyRow colSpan={isAdmin ? 3 : 2} message={t(search ? "attributes.noResults" : "attributes.empty")} /> : null}
            {attributes.map((attribute) => <TableRow key={attribute.id}>
              <TableCell className="pl-4">{localize(attribute.name)}</TableCell><TableCell>{t(`attributeSets.${{ text: "typeText", number: "typeNumberWhole", decimal: "typeDecimal", boolean: "typeBoolean", date: "typeDate", select: "typeSelect" }[attribute.dataType]}`)}</TableCell>
              {isAdmin ? <TableCell className="pr-4 text-right">
                <IconAction label={t("attributes.edit")} icon={Pencil} onClick={() => { setEditing(attribute.id); setNameEn(attribute.name.en); setNameFr(attribute.name.fr); setError(null); setOpen(true); }} />
                <IconAction label={t("attributes.remove")} icon={Trash2} onClick={() => setRemoving({ id: attribute.id, name: localize(attribute.name) })} />
              </TableCell> : null}
            </TableRow>)}
          </TableBody>
        </Table>
        {query.data ? (
          <PaginationControls total={query.data.total} pageSize={pageSize} page={page} onPageChange={list.setPage} />
        ) : null}
      </Card>
      {open ? (
        <Dialog open onOpenChange={(value) => !value && setOpen(false)}>
          <DialogContent>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <DialogHeader><DialogTitle>{t(editing ? "attributes.edit" : "attributes.create")}</DialogTitle><DialogDescription>{t("attributes.createDescription")}</DialogDescription></DialogHeader>
              <ErrorAlert message={error} />
              <FormField label={t("common.nameEnglish")} name="name.en" value={nameEn} onChange={setNameEn} required maxLength={100} />
              <FormField label={t("common.nameFrench")} name="name.fr" value={nameFr} onChange={setNameFr} maxLength={100} />
              {!editing ? <>
                <SelectField label={t("attributeSets.dataType")} value={dataType} onChange={(value) => {
                  if (value === "text" || value === "number" || value === "decimal" || value === "boolean" || value === "date" || value === "select") setDataType(value);
                }} options={[
                  { value: "text", label: t("attributeSets.typeText") },
                  { value: "number", label: t("attributeSets.typeNumberWhole") },
                  { value: "decimal", label: t("attributeSets.typeDecimal") },
                  { value: "boolean", label: t("attributeSets.typeBoolean") },
                  { value: "date", label: t("attributeSets.typeDate") },
                  { value: "select", label: t("attributeSets.typeSelect") },
                ]} required />
                <FormField label={t("attributeSets.unitOptional")} value={unit} onChange={setUnit} maxLength={20} />
                {dataType === "select" ? <div className="flex flex-col gap-2">
                  {options.map((option, index) => <div key={index} className="flex items-end gap-2">
                    <div className="flex-1"><FormField label={t("attributeSets.optionLabel", { index: index + 1 })} value={option} maxLength={100} onChange={(value) => setOptions((current) => current.map((item, i) => i === index ? value : item))} /></div>
                    <Button type="button" variant="outline" aria-label={t("attributeSets.removeOption", { index: index + 1 })} disabled={options.length === 1} onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}><Trash2 /></Button>
                  </div>)}
                  <Button type="button" variant="outline" className="self-start" disabled={options.length >= 100} onClick={() => setOptions((current) => [...current, ""])}>{t("attributeSets.addOption")}</Button>
                </div> : null}
              </> : null}
              <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={submitting || !nameEn.trim()}>{t("common.save")}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t("attributes.removeTitle", { name: removing?.name ?? "" })}
        description={t("attributes.removeDescription")}
        confirmLabel={t("attributes.remove")}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog open={migrateConfirm} title={t("attributes.migrateLegacy")} description={t("attributes.migrateDescription")}
        confirmLabel={t("attributes.migrateConfirm")} busy={migrating} onConfirm={() => void migrateLegacy()} onCancel={() => { if (!migrating) setMigrateConfirm(false); }} />
      {migrationResult ? <Dialog open onOpenChange={(value) => !value && setMigrationResult(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t("attributes.migrateResultTitle")}</DialogTitle><DialogDescription>{t("attributes.migrateResult", { migrated: migrationResult.migrated.length, conflicts: migrationResult.conflicts.length })}</DialogDescription></DialogHeader>
          {migrationResult.conflicts.length ? <ul className="space-y-2 text-sm">{migrationResult.conflicts.map((item) =>
            <li key={item.fieldId}><Link className="underline" to={`/attribute-sets/${item.setId}`}>{item.setName}</Link> · {item.name}: {item.reason}</li>)}</ul> : null}
          <DialogFooter><Button type="button" onClick={() => setMigrationResult(null)}>{t("common.close")}</Button></DialogFooter>
        </DialogContent>
      </Dialog> : null}
    </div>
  );
}

interface CreateAttributeSetDialogProps {
  onClose: () => void;
  onCreated: (id: string) => void;
}

function CreateAttributeSetDialog({ onClose, onCreated }: CreateAttributeSetDialogProps) {
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
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>(
        "POST",
        "/attribute-sets",
        { name: { en: nameEn, fr: nameFr } },
      );
      onCreated(result.attributeSet.id);
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
            <DialogTitle>{t("attributeSets.createSetTitle")}</DialogTitle>
            <DialogDescription>{t("attributeSets.createSetDescription")}</DialogDescription>
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
              {submitting ? t("common.saving") : t("attributeSets.createSetButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AttributeSetBuilderPage() {
  const { user } = useAuth();
  const { attributeSetId } = useParams<{ attributeSetId: string }>();
  const navigate = useNavigate();

  if (!attributeSetId) {
    return <Navigate to="/attribute-sets" replace />;
  }

  return (
    <AttributeSetBuilder
      attributeSetId={attributeSetId}
      isAdmin={user?.role === "admin"}
      onBack={() => navigate("/attribute-sets")}
      onDeleted={() => navigate("/attribute-sets", { replace: true })}
    />
  );
}
