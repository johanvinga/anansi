import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components/Button";
import { Tree, TreeItem, TreeItemContent } from "react-aria-components/Tree";
import { Check, ChevronRight, Filter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiRequest, errorMessage } from "../api/client";
import { localize } from "../api/translations";
import type { Category } from "../api/types";
import { ErrorAlert } from "./error-alert";

interface CategoryTreeFilterProps {
  selected: string[];
  onChange: (selected: string[]) => void;
  uncategorized?: boolean;
  onUncategorizedChange?: (value: boolean) => void;
  mode?: "filter" | "assignment";
  maxSelected?: number;
}

interface CategoryNode {
  category: Category;
  children: CategoryNode[];
}

export function CategoryTreeFilter({ selected, onChange, uncategorized, onUncategorizedChange, mode = "filter", maxSelected = 20 }: CategoryTreeFilterProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limitError, setLimitError] = useState(false);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const query = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await apiRequest<{ items: Category[] }>("GET", "/categories")).items,
  });
  const { roots, searchableParents, visibleIds } = useMemo(() => {
    const categories = query.data ?? [];
    const needle = search.trim().toLocaleLowerCase();
    const shown = new Set<string>();
    for (const category of categories) {
      if (!needle || category.path.some((part) => localize(part.name).toLocaleLowerCase().includes(needle))) {
        for (const part of category.path) shown.add(part.id);
      }
    }
    const nodes = new Map(categories.filter((category) => shown.has(category.id))
      .map((category) => [category.id, { category, children: [] as CategoryNode[] } satisfies CategoryNode]));
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.category.parentId ? nodes.get(node.category.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return { roots, searchableParents: new Set([...nodes.values()].filter((node) => node.children.length).map((node) => node.category.id)), visibleIds: shown };
  }, [query.data, search]);
  function renderNode(node: CategoryNode): React.ReactElement {
    const label = localize(node.category.name);
    const path = node.category.path.map((part) => localize(part.name)).join(" / ");
    return <TreeItem key={node.category.id} id={node.category.id} textValue={label} aria-label={path}
      className="group flex items-center rounded px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-accent">
      <TreeItemContent>
        {({ hasChildItems, isExpanded, isSelected }) => <>
          <span className="shrink-0 w-[calc((var(--tree-item-level)-1)*1rem)]" aria-hidden />
          {hasChildItems ? <AriaButton slot="chevron" className="flex size-7 shrink-0 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className={isExpanded ? "size-4 rotate-90" : "size-4"} aria-hidden />
          </AriaButton> : <span className="size-7 shrink-0" />}
          <span aria-hidden className="mr-2 flex size-4 shrink-0 items-center justify-center rounded border">{isSelected ? <Check className="size-3" /> : null}</span>
          <span title={path}>{label}</span>
        </>}
      </TreeItemContent>
      {node.children.map(renderNode)}
    </TreeItem>;
  }
  const count = selected.length + (uncategorized ? 1 : 0);
  const title = t(mode === "filter" ? "categories.filterTitle" : "categories.assignmentTitle");
  return <Popover open={open} onOpenChange={(next) => { openRef.current = next; setOpen(next); }}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline"><Filter />{t(mode === "filter" ? "categories.filterButton" : "categories.assignmentButton")}{count ? ` (${count})` : ""}</Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-[90vw]">
      <p className="font-medium">{title}</p>
      <Input aria-label={t("categories.filterSearch")} placeholder={t("categories.filterSearch")} value={search} onChange={(event) => setSearch(event.target.value)} />
      {query.isLoading ? <p role="status">{t("common.loading")}</p> : null}
      {query.isError ? <><ErrorAlert message={errorMessage(query.error)} /><Button variant="outline" type="button" onClick={() => void query.refetch()}>{t("categories.filterRetry")}</Button></> : null}
      {limitError ? <ErrorAlert message={t("categories.selectionLimit", { count: maxSelected })} /> : null}
      {query.isSuccess && !roots.length ? <p>{t("categories.filterNoResults")}</p> : null}
      {roots.length ? <Tree aria-label={title} selectionMode="multiple" selectionBehavior="toggle"
        selectedKeys={new Set(selected)} expandedKeys={search.trim() ? searchableParents : expanded}
        onExpandedChange={(keys) => setExpanded(new Set([...keys].map(String)))}
        onSelectionChange={(keys) => {
          if (!openRef.current) return;
          const next = [...new Set([
            ...selected.filter((id) => !visibleIds.has(id)),
            ...(keys === "all" ? [...visibleIds] : [...keys].map(String)),
          ])];
          if (next.length > maxSelected) { setLimitError(true); return; }
          setLimitError(false); onChange(next);
        }} className="max-h-64 overflow-auto outline-none">
        {roots.map(renderNode)}
      </Tree> : null}
      {onUncategorizedChange ? <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={Boolean(uncategorized)} onCheckedChange={(checked) => onUncategorizedChange(checked === true)} />
        {t("categories.filterUncategorized")}
      </label> : null}
      <Button type="button" variant="ghost" onClick={() => { onChange([]); onUncategorizedChange?.(false); setLimitError(false); }}>{t(mode === "filter" ? "categories.filterClear" : "categories.clearSelection")}</Button>
    </PopoverContent>
  </Popover>;
}
