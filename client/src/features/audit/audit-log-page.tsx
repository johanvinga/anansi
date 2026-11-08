import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Eye, Filter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import type { AuditLogDetail, AuditLogSummary, Page } from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { PaginationControls } from "../../components/pagination-controls";
import { TableEmptyRow } from "../../components/table-empty-row";

const PAGE_SIZE = 25;

interface Filters {
  action: string;
  entityType: string;
  from: string;
  to: string;
}

const emptyFilters: Filters = { action: "", entityType: "", from: "", to: "" };

function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge variant={outcome === "success" ? "success" : "destructive"}>{outcome}</Badge>;
}

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
    <>
      <PageHeader title="Audit log" breadcrumbs={[{ label: "Audit log" }]} />

      <Card className="gap-0 py-0">
        <form className="flex flex-wrap items-end gap-3 p-4" onSubmit={applyFilters} role="search">
          <div className="min-w-48 flex-1">
            <FormField label="Action" name="action" value={draft.action} onChange={(action) => setDraft({ ...draft, action })} />
          </div>
          <div className="min-w-48 flex-1">
            <FormField
              label="Entity type"
              name="entityType"
              value={draft.entityType}
              onChange={(entityType) => setDraft({ ...draft, entityType })}
            />
          </div>
          <div className="min-w-40">
            <FormField label="From" name="from" type="date" value={draft.from} onChange={(from) => setDraft({ ...draft, from })} />
          </div>
          <div className="min-w-40">
            <FormField label="To" name="to" type="date" value={draft.to} onChange={(to) => setDraft({ ...draft, to })} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="outline">
              <Filter />
              Apply
            </Button>
            <Button type="button" variant="ghost" onClick={clearFilters}>
              <X />
              Clear
            </Button>
          </div>
        </form>

        {error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={error} />
          </div>
        ) : null}

        <Table aria-label="Audit log">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">Time (UTC)</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead className="pr-4 text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? <TableEmptyRow colSpan={6} message="No entries match the filters." /> : null}
            {result?.items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="pl-4 font-mono text-xs">
                  {new Date(entry.occurredAt).toISOString().replace("T", " ").slice(0, 19)}
                </TableCell>
                <TableCell>{entry.actorEmail}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">
                    {entry.action}
                  </Badge>
                </TableCell>
                <TableCell>
                  <OutcomeBadge outcome={entry.outcome} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {entry.entityType ? `${entry.entityType}${entry.entityId ? ` ${entry.entityId}` : ""}` : "—"}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <IconAction label={`View entry ${entry.action}`} icon={Eye} onClick={() => setSelectedId(entry.id)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {result ? (
          <PaginationControls total={result.total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
        ) : null}
      </Card>

      <Dialog open={selectedId !== null} onOpenChange={(isOpen) => !isOpen && setSelectedId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Audit entry</DialogTitle>
          </DialogHeader>
          {detail ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Action</dt>
              <dd className="font-mono">{detail.action}</dd>
              <dt className="text-muted-foreground">Actor</dt>
              <dd>{detail.actorEmail}</dd>
              <dt className="text-muted-foreground">Outcome</dt>
              <dd>
                <OutcomeBadge outcome={detail.outcome} />
              </dd>
              <dt className="text-muted-foreground">IP address</dt>
              <dd>{detail.ipAddress ?? "—"}</dd>
              <dt className="text-muted-foreground">Request ID</dt>
              <dd className="font-mono text-xs break-all">{detail.requestId}</dd>
              <dt className="text-muted-foreground">Changes</dt>
              <dd className="min-w-0">
                {detail.changes ? (
                  <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(detail.changes, null, 2)}
                  </pre>
                ) : (
                  "None recorded"
                )}
              </dd>
            </dl>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Loading…
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
