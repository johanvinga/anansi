import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <Badge variant={outcome === "success" ? "success" : "destructive"}>
      {outcome === "success" ? t("audit.success") : t("audit.failure")}
    </Badge>
  );
}

export function AuditLogPage() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const logsQuery = useQuery({
    queryKey: ["audit-log", { page, pageSize: PAGE_SIZE, filters }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (filters.action) params.set("action", filters.action.trim());
      if (filters.entityType) params.set("entityType", filters.entityType.trim());
      if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00Z`).toISOString());
      if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999Z`).toISOString());
      return apiRequest<Page<AuditLogSummary>>("GET", `/audit-log?${params.toString()}`);
    },
  });
  const detailQuery = useQuery({
    queryKey: ["audit-entry", selectedId],
    enabled: selectedId !== null,
    queryFn: async () =>
      (await apiRequest<{ entry: AuditLogDetail }>("GET", `/audit-log/${selectedId}`)).entry,
  });
  const result = logsQuery.data;
  const detail = detailQuery.data;
  const error = logsQuery.error ?? detailQuery.error;

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
      <PageHeader title={t("audit.title")} breadcrumbs={[{ label: t("audit.title") }]} />

      <Card className="gap-0 py-0">
        <form className="flex flex-wrap items-end gap-3 p-4" onSubmit={applyFilters} role="search">
          <div className="min-w-48 flex-1">
            <FormField label={t("audit.action")} name="action" value={draft.action} onChange={(action) => setDraft({ ...draft, action })} />
          </div>
          <div className="min-w-48 flex-1">
            <FormField
              label={t("audit.entityType")}
              name="entityType"
              value={draft.entityType}
              onChange={(entityType) => setDraft({ ...draft, entityType })}
            />
          </div>
          <div className="min-w-40">
            <FormField label={t("audit.from")} name="from" type="date" value={draft.from} onChange={(from) => setDraft({ ...draft, from })} />
          </div>
          <div className="min-w-40">
            <FormField label={t("audit.to")} name="to" type="date" value={draft.to} onChange={(to) => setDraft({ ...draft, to })} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="outline">
              <Filter />
              {t("audit.apply")}
            </Button>
            <Button type="button" variant="ghost" onClick={clearFilters}>
              <X />
              {t("audit.clearFilters")}
            </Button>
          </div>
        </form>

        {error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={errorMessage(error)} />
          </div>
        ) : null}

        <Table aria-label={t("audit.title")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("audit.time")}</TableHead>
              <TableHead>{t("audit.who")}</TableHead>
              <TableHead>{t("audit.action")}</TableHead>
              <TableHead>{t("audit.outcome")}</TableHead>
              <TableHead>{t("audit.entity")}</TableHead>
              <TableHead className="pr-4 text-right">{t("audit.details")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.items.length === 0 ? <TableEmptyRow colSpan={6} message={t("audit.noMatch")} /> : null}
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
                  <IconAction label={t("audit.viewEntry", { action: entry.action })} icon={Eye} onClick={() => setSelectedId(entry.id)} />
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
            <DialogTitle>{t("audit.entryTitle")}</DialogTitle>
          </DialogHeader>
          {detail ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">{t("audit.action")}</dt>
              <dd className="font-mono">{detail.action}</dd>
              <dt className="text-muted-foreground">{t("audit.who")}</dt>
              <dd>{detail.actorEmail}</dd>
              <dt className="text-muted-foreground">{t("audit.outcome")}</dt>
              <dd>
                <OutcomeBadge outcome={detail.outcome} />
              </dd>
              <dt className="text-muted-foreground">{t("audit.ipAddress")}</dt>
              <dd>{detail.ipAddress ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("audit.requestId")}</dt>
              <dd className="font-mono text-xs break-all">{detail.requestId}</dd>
              <dt className="text-muted-foreground">{t("audit.changes")}</dt>
              <dd className="min-w-0">
                {detail.changes ? (
                  <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(detail.changes, null, 2)}
                  </pre>
                ) : detailQuery.error ? (
                  <ErrorAlert message={errorMessage(detailQuery.error)} />
                ) : (
                  t("audit.noneRecorded")
                )}
              </dd>
            </dl>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              {t("common.loading")}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("common.close")}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
