import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from "react";
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
  const [detail, setDetail] = useState<AttributeSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<AttributeField | "new" | null>(null);
  const [removingField, setRemovingField] = useState<AttributeField | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>("GET", `/attribute-sets/${attributeSetId}`);
      setDetail(result.attributeSet);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [attributeSetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const backButton = (
    <Button type="button" variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft />
      Back to attribute sets
    </Button>
  );

  if (!detail) {
    return (
      <>
        <PageHeader
          title="Attribute set"
          breadcrumbs={[{ label: "Attribute sets", to: "/attribute-sets" }, { label: "Builder" }]}
          actions={backButton}
        />
        {error ? (
          <ErrorAlert message={error} />
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading…
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
    setDetail({ ...detail, fields: [...ordered, ...archivedFields] });
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>("POST", `/attribute-sets/${attributeSetId}/fields/reorder`, {
        fieldIds: [...ordered, ...archivedFields].map((f) => f.id),
      });
      setDetail(result.attributeSet);
      setStatus("Field order saved.");
    } catch (err) {
      setDetail(previous);
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
      setDetail(result.attributeSet);
      setStatus(result.result === "archived" ? `${target.name} was archived. Existing values are kept.` : `${target.name} was deleted.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleDeleteSet() {
    setConfirmDelete(false);
    try {
      await apiRequest<void>("DELETE", `/attribute-sets/${attributeSetId}`);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title={detail.name}
        breadcrumbs={[{ label: "Attribute sets", to: "/attribute-sets" }, { label: detail.name }]}
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
            <h2>Fields</h2>
          </CardTitle>
          {isAdmin && activeFields.length > 1 ? (
            <CardDescription>Drag fields to reorder them, or use the Move up and Move down buttons.</CardDescription>
          ) : null}
          {isAdmin ? (
            <CardAction className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setRenaming(true)}>
                <Pencil />
                Rename set
              </Button>
              <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                Delete set
              </Button>
              <Button type="button" onClick={() => setEditingField("new")}>
                <Plus />
                Add field
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-6">
          {activeFields.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>No fields yet</EmptyTitle>
                {isAdmin ? <EmptyDescription>Add a field to start building this set.</EmptyDescription> : null}
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
                    <strong className="text-sm font-medium">{field.name}</strong>
                    <Badge variant="secondary">{TYPE_LABELS[field.dataType]}</Badge>
                    {field.isRequired ? <Badge variant="warning">Required</Badge> : null}
                    {field.unit ? <Badge variant="outline">{field.unit}</Badge> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    code: <span className="font-mono">{field.code}</span>
                    {field.dataType === "select" ? ` · ${field.options.map((o) => o.label).join(", ")}` : ""}
                  </span>
                </div>
                {isAdmin ? (
                  <div className="flex items-center gap-1">
                    <IconAction
                      label={`Move ${field.name} up`}
                      icon={ArrowUp}
                      disabled={index === 0}
                      onClick={() => moveField(field.id, index - 1)}
                    />
                    <IconAction
                      label={`Move ${field.name} down`}
                      icon={ArrowDown}
                      disabled={index === activeFields.length - 1}
                      onClick={() => moveField(field.id, index + 1)}
                    />
                    <IconAction label={`Edit ${field.name}`} icon={Pencil} onClick={() => setEditingField(field)} />
                    <IconAction
                      label={field.hasValues ? `Archive ${field.name}` : `Delete ${field.name}`}
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
              <h2>Archived fields</h2>
            </CardTitle>
            <CardDescription>Hidden from product forms. Values already saved on products are kept.</CardDescription>
          </CardHeader>
          <CardContent className="px-6">
            <ul className="flex flex-col gap-2 text-sm">
              {archivedFields.map((field) => (
                <li key={field.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  {field.name}
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
            setDetail(updated);
            setEditingField(null);
            setStatus("Field saved.");
          }}
        />
      ) : null}

      {renaming ? (
        <RenameSetDialog
          detail={detail}
          onClose={() => setRenaming(false)}
          onSaved={(updated) => {
            setDetail(updated);
            setRenaming(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removingField !== null}
        title={removingField?.hasValues ? `Archive ${removingField.name}?` : `Delete ${removingField?.name ?? "field"}?`}
        description={
          removingField?.hasValues
            ? "Products already have values for this field. It will be archived: hidden from forms, with existing values kept."
            : "The field will be permanently deleted."
        }
        confirmLabel={removingField?.hasValues ? "Archive field" : "Delete field"}
        onConfirm={() => void confirmRemoveField()}
        onCancel={() => setRemovingField(null)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${detail.name}?`}
        description="The attribute set and all of its fields will be deleted. Sets used by products cannot be deleted."
        confirmLabel="Delete set"
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
  const [name, setName] = useState(detail.name);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>("PUT", `/attribute-sets/${detail.id}`, { name });
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
            <DialogTitle>Rename attribute set</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <FormField label="Name" name="name" value={name} onChange={setName} required error={error ?? undefined} />
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
