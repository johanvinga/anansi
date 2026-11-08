import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { KeyRound, Pencil, Plus } from "lucide-react";
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
import { SelectField } from "../../components/select-field";
import { TableEmptyRow } from "../../components/table-empty-row";

const PAGE_SIZE = 25;

const roleOptions: { value: UserRole; label: string }[] = [
  { value: "standard", label: "Standard (read-only)" },
  { value: "admin", label: "Admin" },
];

export function UsersPage() {
  const { user: me } = useAuth();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<CurrentUser> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CurrentUser | null>(null);
  const [resetting, setResetting] = useState<CurrentUser | null>(null);
  const [deactivating, setDeactivating] = useState<CurrentUser | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) {
      params.set("q", search);
    }
    try {
      setResult(await apiRequest<Page<CurrentUser>>("GET", `/users?${params.toString()}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(target: CurrentUser, role: UserRole) {
    setRowError(null);
    try {
      await apiRequest<{ user: CurrentUser }>("PATCH", `/users/${target.id}`, { role });
      await load();
    } catch (err) {
      setRowError(errorMessage(err));
    }
  }

  async function setActive(target: CurrentUser, isActive: boolean) {
    setRowError(null);
    try {
      await apiRequest<{ user: CurrentUser }>("PATCH", `/users/${target.id}`, { isActive });
      await load();
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
      <PageHeader title="Users" breadcrumbs={[{ label: "Users" }]} />

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <SearchForm
            label="Search by email or name"
            placeholder="Search by email or name…"
            value={query}
            onChange={setQuery}
            onSearch={() => {
              setPage(1);
              setSearch(query.trim());
            }}
          />
          <Button size="lg" onClick={() => setCreateOpen(true)}>
            <Plus />
            New user
          </Button>
        </div>

        {loadError || rowError ? (
          <div className="flex flex-col gap-2 px-4 pb-4">
            <ErrorAlert message={loadError} />
            <ErrorAlert message={rowError} />
          </div>
        ) : null}

        <Table aria-label="Users">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">Email</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? <TableEmptyRow colSpan={6} message="No users found." /> : null}
            {result?.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="pl-4 font-medium">{row.email}</TableCell>
                <TableCell>{row.displayName ?? "—"}</TableCell>
                <TableCell>
                  <div className="w-48">
                    <SelectField
                      label={`Role for ${row.email}`}
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
                <TableCell>{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "Never"}</TableCell>
                <TableCell className="pr-4">
                  <div className="flex justify-end gap-1">
                    <IconAction label={`Edit ${row.email}`} icon={Pencil} onClick={() => setEditing(row)} />
                    <IconAction label={`Reset password for ${row.email}`} icon={KeyRound} onClick={() => setResetting(row)} />
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
          void load();
        }}
      />
      <ConfirmDialog
        open={deactivating !== null}
        title={`Deactivate ${deactivating?.email ?? ""}?`}
        description="The user will be signed out immediately and cannot log in until reactivated."
        confirmLabel="Deactivate"
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
            void load();
          }}
        />
      ) : null}
      {resetting ? (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onReset={() => {
            setResetting(null);
            void load();
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
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        aria-label={`Active for ${user.email}`}
        checked={user.isActive}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {user.isActive ? "Active" : "Inactive"}
      </Label>
    </div>
  );
}

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function CreateUserDialog({ open, onOpenChange, onCreated }: CreateUserDialogProps) {
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
            <DialogTitle>Create user</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            {error && !error.details.length ? <ErrorAlert message={error.message} /> : null}
            <FormField
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={setEmail}
              required
              error={error?.fieldError("email")}
            />
            <FormField
              label="Display name"
              name="displayName"
              value={displayName}
              onChange={setDisplayName}
              error={error?.fieldError("displayName")}
            />
            <FormField
              label="Initial password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              required
              helperText="At least 12 characters."
              error={error?.fieldError("password")}
            />
            <SelectField label="Role" options={roleOptions} value={role} onChange={(next) => next && setRole(next as UserRole)} />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface EditUserDialogProps {
  user: CurrentUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function EditUserDialog({ user, isSelf, onClose, onSaved }: EditUserDialogProps) {
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
            <DialogTitle>Edit {user.email}</DialogTitle>
            {isSelf ? (
              <DialogDescription>Changing your own role may lock you out of admin features.</DialogDescription>
            ) : null}
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error?.message} />
            <FormField
              label="Display name"
              name="displayName"
              value={displayName}
              onChange={setDisplayName}
              error={error?.fieldError("displayName")}
            />
            <SelectField label="Role" options={roleOptions} value={role} onChange={(next) => next && setRole(next as UserRole)} />
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

interface ResetPasswordDialogProps {
  user: CurrentUser;
  onClose: () => void;
  onReset: () => void;
}

function ResetPasswordDialog({ user, onClose, onReset }: ResetPasswordDialogProps) {
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
            <DialogTitle>Reset password for {user.email}</DialogTitle>
            <DialogDescription>
              The user's sessions are signed out and they must choose a new password at next login.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <ErrorAlert message={error?.message} />
            <FormField
              label="Temporary password"
              name="temporaryPassword"
              type="password"
              autoComplete="new-password"
              value={temporaryPassword}
              onChange={setTemporaryPassword}
              required
              helperText="At least 12 characters."
              error={error?.fieldError("temporaryPassword")}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Resetting…" : "Reset password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
