import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { SupplierContact } from "../../api/types";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";

interface ContactsPanelProps {
  supplierId: string;
  isAdmin: boolean;
}

interface ContactFields {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  weChatId: string;
}

const EMPTY_FIELDS: ContactFields = {
  firstName: "",
  lastName: "",
  email: "",
  phoneNumber: "",
  weChatId: "",
};

export function ContactsPanel({ supplierId, isAdmin }: ContactsPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SupplierContact | "new" | null>(null);
  const [deleting, setDeleting] = useState<SupplierContact | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contactsQuery = useQuery({
    queryKey: ["supplier-contacts", supplierId],
    queryFn: async () =>
      (
        await apiRequest<{ contacts: SupplierContact[] }>(
          "GET",
          `/suppliers/${supplierId}/contacts`,
        )
      ).contacts,
  });
  const contacts = contactsQuery.data ?? [];

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["supplier-contacts", supplierId] });
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await apiRequest<void>(
        "DELETE",
        `/suppliers/${supplierId}/contacts/${deleting.id}`,
      );
      setDeleting(null);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      <Card className="h-full gap-0 py-0">
        <CardHeader className="border-b px-6 py-5">
          <CardTitle>{t("suppliers.contacts")}</CardTitle>
          {isAdmin ? (
            <CardAction>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                {t("suppliers.addContact")}
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-6 py-5">
          <ErrorAlert
            message={error ?? (contactsQuery.error ? errorMessage(contactsQuery.error) : null)}
          />
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("suppliers.noContacts")}</p>
          ) : (
            <ul className="divide-y">
              {contacts.map((contact) => (
                <li key={contact.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <dl className="grid min-w-0 grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-sm">
                      <ContactValue label={t("suppliers.firstName")} value={contact.firstName} />
                      <ContactValue label={t("suppliers.lastName")} value={contact.lastName} />
                      <dt className="text-muted-foreground">{t("suppliers.email")}</dt>
                      <dd className="min-w-0 break-words">
                        {contact.email ? (
                          <a className="text-primary underline-offset-4 hover:underline" href={`mailto:${contact.email}`}>
                            {contact.email}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                      <ContactValue label={t("suppliers.phoneNumber")} value={contact.phoneNumber} />
                      <ContactValue label={t("suppliers.weChatId")} value={contact.weChatId} />
                    </dl>
                    {isAdmin ? (
                      <div className="flex shrink-0 gap-1">
                        <IconAction
                          label={t("suppliers.editContact")}
                          icon={Pencil}
                          onClick={() => setEditing(contact)}
                        />
                        <IconAction
                          label={t("suppliers.deleteContact")}
                          icon={Trash2}
                          destructive
                          onClick={() => setDeleting(contact)}
                        />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <ContactDialog
          supplierId={supplierId}
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setError(null);
            await refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t("suppliers.deleteContactTitle")}
        description={t("suppliers.deleteContactDescription")}
        confirmLabel={t("suppliers.deleteContact")}
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function ContactValue({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value ?? "—"}</dd>
    </>
  );
}

interface ContactDialogProps {
  supplierId: string;
  contact: SupplierContact | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function ContactDialog({ supplierId, contact, onClose, onSaved }: ContactDialogProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<ContactFields>(
    contact
      ? {
          firstName: contact.firstName ?? "",
          lastName: contact.lastName ?? "",
          email: contact.email ?? "",
          phoneNumber: contact.phoneNumber ?? "",
          weChatId: contact.weChatId ?? "",
        }
      : EMPTY_FIELDS,
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const path = contact
        ? `/suppliers/${supplierId}/contacts/${contact.id}`
        : `/suppliers/${supplierId}/contacts`;
      await apiRequest(contact ? "PUT" : "POST", path, fields);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldProps = (key: keyof ContactFields) => ({
    name: key,
    value: fields[key],
    onChange: (value: string) => setFields((current) => ({ ...current, [key]: value })),
    error: error?.fieldError(key),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(contact ? "suppliers.editContact" : "suppliers.addContact")}
          </DialogTitle>
          <DialogDescription>{t("suppliers.contactDialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("suppliers.firstName")}
                maxLength={100}
                {...fieldProps("firstName")}
              />
              <FormField
                label={t("suppliers.lastName")}
                maxLength={100}
                {...fieldProps("lastName")}
              />
            </div>
            <FormField
              label={t("suppliers.email")}
              type="email"
              maxLength={254}
              {...fieldProps("email")}
            />
            <FormField
              label={t("suppliers.phoneNumber")}
              maxLength={50}
              {...fieldProps("phoneNumber")}
            />
            <FormField
              label={t("suppliers.weChatId")}
              maxLength={100}
              {...fieldProps("weChatId")}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
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
