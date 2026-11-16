import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest, errorMessage } from "../api/client";

export interface SelectableItem {
  id: string;
  label: string;
}

interface SelectionPage {
  items: SelectableItem[];
  total: number;
}

interface BulkDeleteOptions {
  scope: string;
  endpoint: string;
  loadPage?: (page: number, pageSize: number) => Promise<SelectionPage>;
  onDeleted: () => Promise<void>;
}

export function useBulkDelete({ scope, endpoint, loadPage, onDeleted }: BulkDeleteOptions) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<{ scope: string; items: SelectableItem[]; allPages: boolean }>({
    scope, items: [], allPages: false,
  });
  const [confirmation, setConfirmation] = useState<{ scope: string; items: SelectableItem[]; allPages: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [previousScope, setPreviousScope] = useState(scope);
  const scopeRef = useRef({ value: scope, version: 0 });
  const busyRef = useRef(false);
  useEffect(() => {
    if (scopeRef.current.value !== scope) {
      scopeRef.current = { value: scope, version: scopeRef.current.version + 1 };
    }
  }, [scope]);
  if (previousScope !== scope) {
    setPreviousScope(scope);
    setSelection({ scope, items: [], allPages: false });
    setConfirmation(null);
    setError(null);
    setSuccess(null);
  }
  const selected = selection.scope === scope ? selection.items : [];
  const selectedIds = new Set(selected.map((item) => item.id));
  const busy = loading || deleting;

  function setItems(items: SelectableItem[], allPages = false) {
    setSelection({ scope, items, allPages });
    setError(null);
    setSuccess(null);
  }

  function toggle(item: SelectableItem, checked: boolean) {
    setItems(checked ? [...selected.filter((entry) => entry.id !== item.id), item] : selected.filter((entry) => entry.id !== item.id));
  }

  function togglePage(items: SelectableItem[], checked: boolean) {
    const ids = new Set(items.map((item) => item.id));
    setItems([...selected.filter((item) => !ids.has(item.id)), ...(checked ? items : [])]);
  }

  async function selectAll(total: number) {
    if (!loadPage || busyRef.current) return;
    busyRef.current = true;
    const version = scopeRef.current.version;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const pageSize = 100;
      const items: SelectableItem[] = [];
      for (let page = 1; page <= Math.ceil(total / pageSize); page++) {
        const result = await loadPage(page, pageSize);
        if (result.total !== total) throw new Error(t("bulkDelete.resultsChanged"));
        items.push(...result.items);
      }
      if (items.length !== total || new Set(items.map((item) => item.id)).size !== total) {
        throw new Error(t("bulkDelete.resultsChanged"));
      }
      if (scopeRef.current.value === scope && scopeRef.current.version === version) setSelection({ scope, items, allPages: true });
    } catch (err) {
      if (scopeRef.current.value === scope && scopeRef.current.version === version) setError(errorMessage(err));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  async function confirm() {
    if (!confirmation || confirmation.scope !== scope || busyRef.current) return;
    busyRef.current = true;
    const version = scopeRef.current.version;
    setDeleting(true);
    setError(null);
    setSuccess(null);
    const failures: { item: SelectableItem; message: string }[] = [];
    for (const item of confirmation.items) {
      try {
        await apiRequest<void>("DELETE", `/${endpoint}/${item.id}`);
      } catch (err) {
        failures.push({ item, message: errorMessage(err) });
      }
    }
    const deleted = confirmation.items.length - failures.length;
    if (scopeRef.current.value === confirmation.scope && scopeRef.current.version === version) {
      setSelection({ scope: confirmation.scope, items: failures.map(({ item }) => item), allPages: false });
    }
    setConfirmation(null);
    if (deleted > 0) setSuccess(t("bulkDelete.deleted", { count: deleted }));
    if (failures.length) {
      setError(`${t("bulkDelete.failed", { count: failures.length })} ${failures.map(({ item, message }) => `${item.label}: ${message}`).join(" | ")}`);
    }
    try {
      await onDeleted();
    } catch (err) {
      setError((current) => [current, errorMessage(err)].filter(Boolean).join(" | "));
    } finally {
      busyRef.current = false;
      setDeleting(false);
    }
  }

  return {
    selected, selectedIds, busy, loading, deleting, error, success,
    toggle, togglePage, selectAll,
    remove: (id: string) => setSelection((current) => current.scope === scope
      ? { ...current, items: current.items.filter((item) => item.id !== id), allPages: false }
      : current),
    requestDelete: () => setConfirmation({ scope, items: selected, allPages: selection.scope === scope && selection.allPages }),
    confirmation: confirmation?.scope === scope ? confirmation : null,
    confirm,
    cancel: () => { if (!deleting) setConfirmation(null); },
  };
}

export type BulkDeleteState = ReturnType<typeof useBulkDelete>;
