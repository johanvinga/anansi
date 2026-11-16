import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { BulkDeleteState, SelectableItem } from "../hooks/use-bulk-delete";
import { ConfirmDialog } from "./confirm-dialog";
import { ErrorAlert, SuccessAlert } from "./error-alert";

interface BulkSelectPageProps {
  items: SelectableItem[];
  selection: BulkDeleteState;
}

export function BulkSelectPage({ items, selection }: BulkSelectPageProps) {
  const { t } = useTranslation();
  const count = items.filter((item) => selection.selectedIds.has(item.id)).length;
  return <Checkbox
    aria-label={t("bulkDelete.selectPage")}
    checked={items.length > 0 && count === items.length ? true : count > 0 ? "indeterminate" : false}
    disabled={selection.busy || items.length === 0}
    onCheckedChange={(checked) => selection.togglePage(items, checked === true)}
  />;
}

interface BulkSelectItemProps {
  item: SelectableItem;
  selection: BulkDeleteState;
}

export function BulkSelectItem({ item, selection }: BulkSelectItemProps) {
  const { t } = useTranslation();
  return <Checkbox
    aria-label={t("bulkDelete.selectItem", { name: item.label })}
    checked={selection.selectedIds.has(item.id)}
    disabled={selection.busy}
    onCheckedChange={(checked) => selection.toggle(item, checked === true)}
  />;
}

interface BulkDeleteControlsProps {
  selection: BulkDeleteState;
  visibleItems: SelectableItem[];
  total?: number;
  pageSize?: number;
  warning: string;
}

export function BulkDeleteControls({ selection, visibleItems, total, pageSize, warning }: BulkDeleteControlsProps) {
  const { t } = useTranslation();
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  const acrossPages = selection.confirmation?.items.some((item) => !visibleIds.has(item.id)) ?? false;
  return <>
    {selection.error || selection.success || selection.selected.length > 0 || (total !== undefined && pageSize !== undefined && total > pageSize) ? <div className="flex flex-col gap-2 px-4 py-3">
      {selection.error ? <ErrorAlert message={selection.error} /> : null}
      {selection.success ? <SuccessAlert message={selection.success} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        {selection.selected.length > 0 ? <>
          <span className="text-sm">{t("bulkDelete.selected", { count: selection.selected.length })}</span>
          <Button type="button" variant="destructive" disabled={selection.busy} onClick={selection.requestDelete}>
            <Trash2 />{t("bulkDelete.deleteSelected")}
          </Button>
        </> : null}
        {total !== undefined && pageSize !== undefined && total > pageSize ? (
          <Button type="button" variant="outline" disabled={selection.busy} onClick={() => void selection.selectAll(total)}>
            {selection.loading ? t("bulkDelete.loading") : t("bulkDelete.selectAll", { count: total })}
          </Button>
        ) : null}
      </div>
    </div> : null}
    <ConfirmDialog
      open={selection.confirmation !== null}
      title={t("bulkDelete.confirmTitle", { count: selection.confirmation?.items.length ?? 0 })}
      description={`${t(selection.confirmation?.allPages ? "bulkDelete.confirmAllPages" : acrossPages ? "bulkDelete.confirmAcrossPages" : "bulkDelete.confirmDescription", { count: selection.confirmation?.items.length ?? 0 })} ${warning}`}
      confirmLabel={selection.deleting ? t("bulkDelete.deleting") : t("bulkDelete.deleteSelected")}
      busy={selection.deleting}
      onConfirm={() => void selection.confirm()}
      onCancel={selection.cancel}
    />
  </>;
}
