import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent, type FormEvent } from "react";
import { Archive, ArrowDown, ArrowLeft, ArrowUp, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { AttributeField, AttributeSetDetail } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { FieldDialog } from "./field-dialog";

const TYPE_LABELS: Record<AttributeField["dataType"], string> = {
  text: "Text",
  number: "Number",
  decimal: "Decimal",
  boolean: "Yes / no",
  date: "Date",
  select: "Select",
};

interface AttributeSetBuilderProps {
  attributeSetId: string;
  isAdmin: boolean;
  onBack: () => void;
  onDeleted: () => void;
}

/** Shows an attribute set and lets admins manage and reorder its fields (FR-ATS-02..09, FR-UI-02). */
export function AttributeSetBuilder({ attributeSetId, isAdmin, onBack, onDeleted }: AttributeSetBuilderProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<AttributeField | "new" | null>(null);
  const [removingField, setRemovingField] = useState<AttributeField | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["attribute-set", attributeSetId],
    queryFn: () =>
      apiRequest<{ attributeSet: AttributeSetDetail }>("GET", `/attribute-sets/${attributeSetId}`),
  });
  const detail = detailQuery.data?.attributeSet ?? null;

  function cacheDetail(updated: AttributeSetDetail) {
    queryClient.setQueryData(["attribute-set", attributeSetId], { attributeSet: updated });
  }

  const backButton = (
    <Button type="button" variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft />
            {t("attributeSets.backToSets")}
    </Button>
  );

  if (!detail) {
    return (
      <>
        <PageHeader
          title={t("attributeSets.attributeSet")}
          breadcrumbs={[{ label: t("attributeSets.title"), to: "/attribute-sets" }, { label: t("attributeSets.builder") }]}
          actions={backButton}
        />
        {error || detailQuery.error ? (
            <ErrorAlert message={error ?? (detailQuery.error ? errorMessage(detailQuery.error) : null)} />
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t("common.loading")}
          </p>
        )}
      </>
    );
  }

  const activeFields = detail.fields.filter((f) => !f.isArchived);
  const archivedFields = detail.fields.filter((f) => f.isArchived);

  async function saveOrder(ordered: AttributeField[]) {
    if (!detail) return;
    const previous = detail;
    // Optimistic update; archived fields keep their place after the active ones.
    cacheDetail({ ...detail, fields: [...ordered, ...archivedFields] });
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>("POST", `/attribute-sets/${attributeSetId}/fields/reorder`, {
        fieldIds: [...ordered, ...archivedFields].map((f) => f.id),
      });
      cacheDetail(result.attributeSet);
      void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
      setStatus(t("attributeSets.orderSaved"));
    } catch (err) {
      cacheDetail(previous);
      setError(errorMessage(err));
    }
  }

  function moveField(fromId: string, toIndex: number) {
    const fromIndex = activeFields.findIndex((f) => f.id === fromId);
    if (fromIndex < 0 || toIndex < 0 || toIndex >= activeFields.length || fromIndex === toIndex) return;
    const next = [...activeFields];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    void saveOrder(next);
  }

  function handleDrop(event: DragEvent<HTMLLIElement>, targetId: string) {
    event.preventDefault();
    const sourceId = dragId ?? event.dataTransfer.getData("text/plain");
    setDragId(null);
    setDropTargetId(null);
    if (sourceId && sourceId !== targetId) {
      moveField(sourceId, activeFields.findIndex((f) => f.id === targetId));
    }
  }

  async function confirmRemoveField() {
    if (!removingField) return;
    const target = removingField;
    setRemovingField(null);
    try {
      const result = await apiRequest<{ result: "archived" | "deleted"; attributeSet: AttributeSetDetail }>(
        "DELETE",
        `/attribute-sets/${attributeSetId}/fields/${target.id}`,
      );
      cacheDetail(result.attributeSet);
      void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
      setStatus(result.result === "archived" ? t("attributeSets.wasArchived", { name: localize(target.name) }) : t("attributeSets.wasDeleted", { name: localize(target.name) }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleDeleteSet() {
    setConfirmDelete(false);
    try {
      await apiRequest<void>("DELETE", `/attribute-sets/${attributeSetId}`);
      await queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title={localize(detail.name)}
        breadcrumbs={[{ label: t("attributeSets.title"), to: "/attribute-sets" }, { label: localize(detail.name) }]}
        actions={backButton}
      />

      <ErrorAlert message={error} />
      {status ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      ) : null}

      <Card className="gap-4 py-6">
        <CardHeader className="px-6">
          <CardTitle>
            <h2>{t("attributeSets.buildFields")}</h2>
          </CardTitle>
          {isAdmin && activeFields.length > 1 ? (
            <CardDescription>{t("attributeSets.dragHint")}</CardDescription>
          ) : null}
          {isAdmin ? (
            <CardAction className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setRenaming(true)}>
                <Pencil />
                {t("attributeSets.renameSet")}
              </Button>
              <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t("attributeSets.deleteSet")}
              </Button>
              <Button type="button" onClick={() => setEditingField("new")}>
                <Plus />
                {t("attributeSets.addField")}
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-6">
          {activeFields.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>{t("attributeSets.noFields")}</EmptyTitle>
                {isAdmin ? <EmptyDescription>{t("attributeSets.noFieldsHint")}</EmptyDescription> : null}
              </EmptyHeader>
            </Empty>
          ) : null}
          <ol className="flex flex-col gap-2">
            {activeFields.map((field, index) => (
              <li
                key={field.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors",
                  dropTargetId === field.id && "border-primary ring-2 ring-ring/50",
                  dragId === field.id && "opacity-50",
                )}
                draggable={isAdmin}
                onDragStart={(event) => {
                  setDragId(field.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", field.id);
                }}
                onDragOver={(event) => {
                  if (!isAdmin) return;
                  event.preventDefault();
                  setDropTargetId(field.id);
                }}
                onDragLeave={() => setDropTargetId((current) => (current === field.id ? null : current))}
                onDrop={(event) => handleDrop(event, field.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTargetId(null);
                }}
              >
                {isAdmin ? <GripVertical aria-hidden="true" className="size-4 shrink-0 cursor-grab text-muted-foreground" /> : null}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-medium">{localize(field.name)}</strong>
                    <Badge variant="secondary">{TYPE_LABELS[field.dataType]}</Badge>
                    {field.isRequired ? <Badge variant="warning">{t("attributeSets.required")}</Badge> : null}
                    {field.unit ? <Badge variant="outline">{field.unit}</Badge> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    code: <span className="font-mono">{field.code}</span>
                    {field.dataType === "select" ? ` Â· ${field.options.map((o) => localize(o.label)).join(", ")}` : ""}
                  </span>
                </div>
                {isAdmin ? (
                  <div className="flex items-center gap-1">
                    <IconAction
                      label={t("attributeSets.moveUp", { name: localize(field.name) })}
                      icon={ArrowUp}
                      disabled={index === 0}
                      onClick={() => moveField(field.id, index - 1)}
                    />
                    <IconAction
                      label={t("attributeSets.moveDown", { name: localize(field.name) })}
                      icon={ArrowDown}
                      disabled={index === activeFields.length - 1}
                      onClick={() => moveField(field.id, index + 1)}
                    />
                    <IconAction label={t("attributeSets.editFieldAria", { name: localize(field.name) })} icon={Pencil} onClick={() => setEditingField(field)} />
                    <IconAction
                      label={field.hasValues ? t("attributeSets.archiveAria", { name: localize(field.name) }) : t("attributeSets.deleteAria2", { name: localize(field.name) })}
                      icon={field.hasValues ? Archive : Trash2}
                      destructive
                      onClick={() => setRemovingField(field)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {archivedFields.length > 0 ? (
        <Card className="gap-4 py-6">
          <CardHeader className="px-6">
            <CardTitle>
              <h2>{t("attributeSets.archivedFields")}</h2>
            </CardTitle>
            <CardDescription>{t("attributeSets.archivedHint")}</CardDescription>
          </CardHeader>
          <CardContent className="px-6">
            <ul className="flex flex-col gap-2 text-sm">
              {archivedFields.map((field) => (
                <li key={field.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  {localize(field.name)}
                  <Badge variant="outline">{TYPE_LABELS[field.dataType]}</Badge>
                  <span className="font-mono text-xs">{field.code}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {editingField ? (
        <FieldDialog
          attributeSetId={attributeSetId}
          field={editingField === "new" ? undefined : editingField}
          onClose={() => setEditingField(null)}
          onSaved={(updated) => {
            cacheDetail(updated);
            setEditingField(null);
            void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
            setStatus(t("attributeSets.fieldSaved"));
          }}
        />
      ) : null}

      {renaming ? (
        <RenameSetDialog
          detail={detail}
          onClose={() => setRenaming(false)}
          onSaved={(updated) => {
            cacheDetail(updated);
            setRenaming(false);
            void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removingField !== null}
        title={removingField?.hasValues ? t("attributeSets.archiveTitle", { name: localize(removingField.name) }) : t("attributeSets.confirmDeleteFieldTitle", { name: removingField ? localize(removingField.name) : t("attributeSets.fieldWord") })}
        description={
          removingField?.hasValues
            ? t("attributeSets.archiveDescription")
            : t("attributeSets.deleteDescription")
        }
        confirmLabel={removingField?.hasValues ? t("attributeSets.archiveOrDeleteField") : t("attributeSets.deleteField")}
        onConfirm={() => void confirmRemoveField()}
        onCancel={() => setRemovingField(null)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={t("attributeSets.confirmDeleteFieldTitle", { name: localize(detail.name) })}
        description={t("attributeSets.confirmDeleteSetDescription")}
        confirmLabel={t("attributeSets.deleteSet")}
        onConfirm={() => void handleDeleteSet()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

interface RenameSetDialogProps {
  detail: AttributeSetDetail;
  onClose: () => void;
  onSaved: (detail: AttributeSetDetail) => void;
}

function RenameSetDialog({ detail, onClose, onSaved }: RenameSetDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(localize(detail.name));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>("PUT", `/attribute-sets/${detail.id}`, { name: { en: name, fr: detail.name.fr } });
      onSaved(result.attributeSet);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t("attributeSets.renameTitle")}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <FormField label={t("suppliers.name")} name="name" value={name} onChange={setName} required error={error ?? undefined} />
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
