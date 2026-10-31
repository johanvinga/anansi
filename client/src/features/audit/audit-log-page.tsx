import { Dialog } from "@ark-ui/react/dialog";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiRequest, errorMessage } from "../../api/client";
import type { AuditLogDetail, AuditLogSummary, Page } from "../../api/types";
import { FormField } from "../../components/form-field";
import { PaginationControls } from "../../components/pagination-controls";

const PAGE_SIZE = 25;

interface Filters {
  action: string;
  entityType: string;
  from: string;
  to: string;
}

const emptyFilters: Filters = { action: "", entityType: "", from: "", to: "" };

export function AuditLogPage() {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<AuditLogSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditLogDetail | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (filters.action) params.set("action", filters.action.trim());
    if (filters.entityType) params.set("entityType", filters.entityType.trim());
    if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00Z`).toISOString());
    if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999Z`).toISOString());
    try {
      setResult(await apiRequest<Page<AuditLogSummary>>("GET", `/audit-log?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [page, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    apiRequest<{ entry: AuditLogDetail }>("GET", `/audit-log/${selectedId}`)
      .then((response) => setDetail(response.entry))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [selectedId]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters(draft);
  }

  function clearFilters() {
    setDraft(emptyFilters);
    setPage(1);
    setFilters(emptyFilters);
  }

  return (
    <section className="page">
      <h1>Audit log</h1>

      <form className="toolbar filters" onSubmit={applyFilters} role="search">
        <FormField label="Action" name="action" value={draft.action} onChange={(action) => setDraft({ ...draft, action })} />
        <FormField label="Entity type" name="entityType" value={draft.entityType} onChange={(entityType) => setDraft({ ...draft, entityType })} />
        <FormField label="From" name="from" type="date" value={draft.from} onChange={(from) => setDraft({ ...draft, from })} />
        <FormField label="To" name="to" type="date" value={draft.to} onChange={(to) => setDraft({ ...draft, to })} />
        <button type="submit" className="secondary-button">
          Apply
        </button>
        <button type="button" className="secondary-button" onClick={clearFilters}>
          Clear
        </button>
      </form>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Actor</th>
            <th scope="col">Action</th>
            <th scope="col">Outcome</th>
            <th scope="col">Entity</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {result?.items.map((entry) => (
            <tr key={entry.id}>
              <td>{new Date(entry.occurredAt).toISOString().replace("T", " ").slice(0, 19)}</td>
              <td>{entry.actorEmail}</td>
              <td>{entry.action}</td>
              <td>{entry.outcome}</td>
              <td>{entry.entityType ? `${entry.entityType}${entry.entityId ? ` ${entry.entityId}` : ""}` : "—"}</td>
              <td>
                <button type="button" className="secondary-button" onClick={() => setSelectedId(entry.id)}>
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {result ? (
        <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
      ) : null}

      <Dialog.Root open={selectedId !== null} onOpenChange={(details) => !details.open && setSelectedId(null)}>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Positioner className="dialog-positioner">
          <Dialog.Content className="card dialog">
            <Dialog.Title>Audit entry</Dialog.Title>
            {detail ? (
              <dl className="profile">
                <dt>Action</dt>
                <dd>{detail.action}</dd>
                <dt>Actor</dt>
                <dd>{detail.actorEmail}</dd>
                <dt>Outcome</dt>
                <dd>{detail.outcome}</dd>
                <dt>IP address</dt>
                <dd>{detail.ipAddress ?? "—"}</dd>
                <dt>Request ID</dt>
                <dd>{detail.requestId}</dd>
                <dt>Changes</dt>
                <dd>
                  {detail.changes ? <pre>{JSON.stringify(detail.changes, null, 2)}</pre> : "None recorded"}
                </dd>
              </dl>
            ) : (
              <p>Loading…</p>
            )}
            <div className="dialog-actions">
              <Dialog.CloseTrigger className="secondary-button">Close</Dialog.CloseTrigger>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </section>
  );
}
