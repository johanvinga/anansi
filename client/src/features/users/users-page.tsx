import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { KeyRound, Pencil, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { CurrentUser, Page, UserRole } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { PaginationControls } from "../../components/pagination-controls";
import { SearchForm } from "../../components/search-form";
import { SelectField, type SelectOption } from "../../components/select-field";
import { TableEmptyRow } from "../../components/table-empty-row";

const PAGE_SIZE = 25;

function useRoleOptions(): SelectOption[] {
  const { t } = useTranslation();
  return [
    { value: "standard", label: t("users.roleStandardOption") },
    { value: "admin", label: t("users.roleAdminOption") },
  ];
}

export function UsersPage() {
  const { user: me } = useAuth();
  const { t } = useTranslation();
  const roleOptions = useRoleOptions();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rowError, setRowError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CurrentUser | null>(null);
  const [resetting, setResetting] = useState<CurrentUser | null>(null);
  const [deactivating, setDeactivating] = useState<CurrentUser | null>(null);

  const usersQuery = useQuery({
    queryKey: ["users", { page, pageSize: PAGE_SIZE, search }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search) {
        params.set("q", search);
      }
      return apiRequest<Page<CurrentUser>>("GET", `/users?${params.toString()}`);
    },
  });
  const result = usersQuery.data;
  const refresh = () => usersQuery.refetch();

  async function changeRole(target: CurrentUser, role: UserRole) {
    setRowError(null);
    try {
      await apiRequest<{ user: CurrentUser }>("PATCH", `/users/${target.id}`, { role });
      await refresh();
    } catch (err) {
      setRowError(errorMessage(err));
    }
  }

  async function setActive(target: CurrentUser, isActive: boolean) {
    setRowError(null);
    try {
      await apiRequest<{ user: CurrentUser }>("PATCH", `/users/${target.id}`, { isActive });
      await refresh();
    } catch (err) {
      setRowError(errorMessage(err));
    }
  }

  async function confirmDeactivate() {
    if (deactivating) {
      const target = deactivating;
      setDeactivating(null);
      await setActive(target, false);
    }
  }

  return (
    <>
      <PageHeader title={t("users.title")} breadcrumbs={[{ label: t("users.title") }]} />

      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
        <SearchForm
          label={t("users.searchLabel")}
          placeholder={t("users.searchPlaceholder")}
          value={query}
          onChange={setQuery}
          onSearch={() => {
            setPage(1);
            setSearch(query.trim());
          }}
        />
        <Button size="lg" onClick={() => setCreateOpen(true)}>
          <Plus />
          {t("users.createUser")}
        </Button>
      </div>

      <Card className="gap-0 py-0">
        {usersQuery.error || rowError ? (
          <div className="flex flex-col gap-2 px-4 pb-4">
            <ErrorAlert message={usersQuery.error ? errorMessage(usersQuery.error) : null} />
            <ErrorAlert message={rowError} />
          </div>
        ) : null}

        <Table aria-label={t("users.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("users.email")}</TableHead>
              <TableHead>{t("users.displayName")}</TableHead>
              <TableHead>{t("users.role")}</TableHead>
              <TableHead>{t("users.status")}</TableHead>
              <TableHead>{t("users.lastLogin")}</TableHead>
              <TableHead className="pr-4 text-right">{t("users.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? <TableEmptyRow colSpan={6} message={t("users.noUsers")} /> : null}
            {result?.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="pl-4 font-medium">{row.email}</TableCell>
                <TableCell>{row.displayName ?? "—"}</TableCell>
                <TableCell>
                  <div className="w-48">
                    <SelectField
                      label={t("users.roleFor", { email: row.email })}
                      hideLabel
                      options={roleOptions}
                      value={row.role}
                      onChange={(next) => {
                        if (next && next !== row.role) void changeRole(row, next as UserRole);
                      }}
                    />
                  </div>
                </TableCell>
                <TableCell>
                  <ActiveSwitch
                    user={row}
                    disabled={row.id === me?.id && row.isActive}
                    onChange={(isActive) => (isActive ? void setActive(row, true) : setDeactivating(row))}
                  />
                </TableCell>
                <TableCell>
                  {row.lastLoginAt
                    ? new Date(row.lastLoginAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : t("users.never")}
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <IconAction
                      label={t("users.editUserAria", { email: row.email })}
                      icon={Pencil}
                      onClick={() => setEditing(row)}
                    />
                    <IconAction
                      label={t("users.resetPasswordAria", { email: row.email })}
                      icon={KeyRound}
                      onClick={() => setResetting(row)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {result ? (
          <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
        ) : null}
      </Card>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />
      <ConfirmDialog
        open={deactivating !== null}
        title={t("users.confirmDeactivateTitle", { email: deactivating?.email ?? "" })}
        description={t("users.confirmDeactivateDescription")}
        confirmLabel={t("users.deactivate")}
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => setDeactivating(null)}
      />
      {editing ? (
        <EditUserDialog
          user={editing}
          isSelf={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
      {resetting ? (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onReset={() => {
            setResetting(null);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err));
}

interface ActiveSwitchProps {
  user: CurrentUser;
  disabled: boolean;
  onChange: (isActive: boolean) => void;
}

function ActiveSwitch({ user, disabled, onChange }: ActiveSwitchProps) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        aria-label={t("users.activeFor", { email: user.email })}
        checked={user.isActive}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {user.isActive ? t("users.active") : t("users.inactive")}
      </Label>
    </div>
  );
}

function CreateUserDialog({ open, onOpenChange, onCreated }: CreateUserDialogProps) {
  const { t } = useTranslation();
  const roleOptions = useRoleOptions();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("standard");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("POST", "/users", {
        email,
        displayName: displayName.trim() || undefined,
        role,
        password,
      });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("standard");
      onCreated();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>{t("users.createUserTitle")}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            {error && !error.details.length ? <ErrorAlert message={error.message} /> : null}
            <FormField
              label={t("users.email")}
              name="email"
              type="email"
              value={email}
              onChange={setEmail}
              required
              error={error?.fieldError("email")}
            />
            <FormField
              label={t("users.displayName")}
              name="displayName"
              value={displayName}
              onChange={setDisplayName}
              error={error?.fieldError("displayName")}
            />
            <FormField
              label={t("users.initialPassword")}
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              required
              helperText={t("account.passwordHint")}
              error={error?.fieldError("password")}
            />
            <SelectField
              label={t("users.role")}
              options={roleOptions}
              value={role}
              onChange={(next) => next && setRole(next as UserRole)}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("users.creating") : t("users.createUserTitle")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

interface EditUserDialogProps {
  user: CurrentUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function EditUserDialog({ user, isSelf, onClose, onSaved }: EditUserDialogProps) {
  const { t } = useTranslation();
  const roleOptions = useRoleOptions();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [role, setRole] = useState<UserRole>(user.role);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("PATCH", `/users/${user.id}`, { displayName: displayName.trim() || null, role });
      onSaved();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>{t("users.editUserTitle", { email: user.email })}</DialogTitle>
            {isSelf ? <DialogDescription>{t("users.selfRoleWarning")}</DialogDescription> : null}
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error?.message} />
            <FormField
              label={t("users.displayName")}
              name="displayName"
              value={displayName}
              onChange={setDisplayName}
              error={error?.fieldError("displayName")}
            />
            <SelectField
              label={t("users.role")}
              options={roleOptions}
              value={role}
              onChange={(next) => next && setRole(next as UserRole)}
            />
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

interface ResetPasswordDialogProps {
  user: CurrentUser;
  onClose: () => void;
  onReset: () => void;
}

function ResetPasswordDialog({ user, onClose, onReset }: ResetPasswordDialogProps) {
  const { t } = useTranslation();
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest("POST", `/users/${user.id}/reset-password`, { temporaryPassword });
      onReset();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>{t("users.resetPasswordTitle", { email: user.email })}</DialogTitle>
            <DialogDescription>{t("users.resetPasswordDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error?.message} />
            <FormField
              label={t("users.temporaryPassword")}
              name="temporaryPassword"
              type="password"
              autoComplete="new-password"
              value={temporaryPassword}
              onChange={setTemporaryPassword}
              required
              helperText={t("account.passwordHint")}
              error={error?.fieldError("temporaryPassword")}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("users.resetting") : t("users.resetPassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
