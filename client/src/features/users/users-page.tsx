import { Dialog } from "@ark-ui/react/dialog";
import { Select, createListCollection } from "@ark-ui/react/select";
import { Switch } from "@ark-ui/react/switch";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { CurrentUser, Page, UserRole } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { FormField } from "../../components/form-field";
import { PaginationControls } from "../../components/pagination-controls";

const PAGE_SIZE = 25;

const roleOptions = createListCollection<{ label: string; value: UserRole }>({
  items: [
    { label: "Standard (read-only)", value: "standard" },
    { label: "Admin", value: "admin" },
  ],
});

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

  async function toggleRole(target: CurrentUser, role: UserRole) {
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

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(query.trim());
  }

  return (
    <section className="page">
      <div className="page-header">
        <h1>Users</h1>
        <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}>
          New user
        </button>
      </div>

      <form className="toolbar" onSubmit={handleSearch} role="search">
        <FormField label="Search by email or name" name="q" value={query} onChange={setQuery} />
        <button type="submit" className="secondary-button">
          Search
        </button>
      </form>

      {loadError ? (
        <p role="alert" className="form-error">
          {loadError}
        </p>
      ) : null}
      {rowError ? (
        <p role="alert" className="form-error">
          {rowError}
        </p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Display name</th>
            <th scope="col">Role</th>
            <th scope="col">Active</th>
            <th scope="col">Last login</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {result?.items.map((row) => (
            <tr key={row.id}>
              <td>{row.email}</td>
              <td>{row.displayName ?? "—"}</td>
              <td>
                <RoleSelect value={row.role} label={`Role for ${row.email}`} onChange={(role) => void toggleRole(row, role)} />
              </td>
              <td>
                <Switch.Root
                  checked={row.isActive}
                  onCheckedChange={(details) =>
                    details.checked ? void setActive(row, true) : setDeactivating(row)
                  }
                  disabled={row.id === me?.id && row.isActive}
                  className="switch-root"
                >
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Switch.Label>{row.isActive ? "Active" : "Inactive"}</Switch.Label>
                  <Switch.HiddenInput aria-label={`Active for ${row.email}`} />
                </Switch.Root>
              </td>
              <td>{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "Never"}</td>
              <td className="row-actions">
                <button type="button" className="secondary-button" onClick={() => setEditing(row)}>
                  Edit
                </button>
                <button type="button" className="secondary-button" onClick={() => setResetting(row)}>
                  Reset password
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {result ? (
        <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
      ) : null}

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void load();
        }}
      />
      <Dialog.Root open={deactivating !== null} onOpenChange={(details) => !details.open && setDeactivating(null)}>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Positioner className="dialog-positioner">
          <Dialog.Content className="card dialog">
            <Dialog.Title>Deactivate {deactivating?.email}?</Dialog.Title>
            <Dialog.Description>
              The user will be signed out immediately and cannot log in until reactivated.
            </Dialog.Description>
            <div className="dialog-actions">
              <Dialog.CloseTrigger className="secondary-button">Cancel</Dialog.CloseTrigger>
              <button type="button" className="danger-button" onClick={() => void confirmDeactivate()}>
                Deactivate
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
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
    </section>
  );
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err));
}

interface RoleSelectProps {
  value: UserRole;
  label: string;
  onChange: (role: UserRole) => void;
}

function RoleSelect({ value, label, onChange }: RoleSelectProps) {
  return (
    <Select.Root
      collection={roleOptions}
      value={[value]}
      onValueChange={(details) => {
        const next = details.value[0] as UserRole | undefined;
        if (next && next !== value) {
          onChange(next);
        }
      }}
      positioning={{ sameWidth: false }}
    >
      <Select.Control>
        <Select.Trigger aria-label={label} className="select-trigger">
          <Select.ValueText />
          <Select.Indicator>▾</Select.Indicator>
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content className="select-content">
          {roleOptions.items.map((item) => (
            <Select.Item key={item.value} item={item} className="select-item">
              <Select.ItemText>{item.label}</Select.ItemText>
              <Select.ItemIndicator>✓</Select.ItemIndicator>
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
      <Select.HiddenSelect />
    </Select.Root>
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
    <Dialog.Root open={open} onOpenChange={(details) => onOpenChange(details.open)} lazyMount unmountOnExit>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Positioner className="dialog-positioner">
        <Dialog.Content className="card dialog">
          <form onSubmit={handleSubmit} noValidate>
            <Dialog.Title>Create user</Dialog.Title>
            {error && !error.details.length ? (
              <p role="alert" className="form-error">
                {error.message}
              </p>
            ) : null}
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
            <RoleSelect value={role} label="Role" onChange={setRole} />
            <div className="dialog-actions">
              <Dialog.CloseTrigger className="secondary-button">Cancel</Dialog.CloseTrigger>
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Creating…" : "Create user"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
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
    <Dialog.Root open onOpenChange={(details) => !details.open && onClose()}>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Positioner className="dialog-positioner">
        <Dialog.Content className="card dialog">
          <form onSubmit={handleSubmit} noValidate>
            <Dialog.Title>Edit {user.email}</Dialog.Title>
            {error ? (
              <p role="alert" className="form-error">
                {error.message}
              </p>
            ) : null}
            <FormField
              label="Display name"
              name="displayName"
              value={displayName}
              onChange={setDisplayName}
              error={error?.fieldError("displayName")}
            />
            <RoleSelect value={role} label="Role" onChange={setRole} />
            {isSelf ? <p className="helper-text">Changing your own role may lock you out of admin features.</p> : null}
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
    <Dialog.Root open onOpenChange={(details) => !details.open && onClose()}>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Positioner className="dialog-positioner">
        <Dialog.Content className="card dialog">
          <form onSubmit={handleSubmit} noValidate>
            <Dialog.Title>Reset password for {user.email}</Dialog.Title>
            <Dialog.Description>
              The user's sessions are signed out and they must choose a new password at next login.
            </Dialog.Description>
            {error ? (
              <p role="alert" className="form-error">
                {error.message}
              </p>
            ) : null}
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
            <div className="dialog-actions">
              <Dialog.CloseTrigger className="secondary-button">Cancel</Dialog.CloseTrigger>
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? "Resetting…" : "Reset password"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
