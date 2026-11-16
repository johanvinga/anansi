import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { Category } from "../../api/types";
import { CategoryTreeFilter } from "../../components/category-tree-filter";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { SelectField } from "../../components/select-field";
import type { CategoryChip } from "./category-chips";

interface CategoryEditorProps {
  value: CategoryChip[];
  onChange: (value: CategoryChip[]) => void;
  disabled?: boolean;
  maxCategories?: number;
}

export function CategoryEditor({ value, onChange, disabled, maxCategories = 50 }: CategoryEditorProps) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await apiRequest<{ items: Category[] }>("GET", "/categories")).items,
  });
  const categories = query.data ?? [];
  const path = (category: Category) => category.path.map((part) => localize(part.name)).join(" / ");
  const byId = new Map(categories.map((category) => [category.id, category]));
  const selected = value.flatMap((chip) => chip.id ? [chip.id] : []);

  function addDraft() {
    const name = draft.trim();
    if (!name || parent === null) return;
    const parentId = parent === "__root__" ? null : parent;
    const duplicate = categories.some((category) => category.parentId === parentId && category.name.en.trim().toLowerCase() === name.toLowerCase())
      || value.some((chip) => !chip.id && chip.parentId === parentId && chip.name.trim().toLowerCase() === name.toLowerCase());
    if (duplicate) {
      setError(t("categories.siblingExists"));
      return;
    }
    if (value.length >= maxCategories) {
      setError(t("categories.selectionLimit", { count: maxCategories }));
      return;
    }
    onChange([...value, { name, parentId }]);
    setDraft("");
    setParent(null);
    setCreating(false);
    setError(null);
  }

  return <div className="flex flex-col gap-3">
    {query.isError ? <><ErrorAlert message={errorMessage(query.error)} /><Button type="button" variant="outline" onClick={() => void query.refetch()}>{t("categories.filterRetry")}</Button></> : null}
    {value.length === 0 ? <p className="text-sm text-muted-foreground">{t("categories.noneAssigned")}</p> : null}
    <ul aria-label={t("categories.title")} className="flex flex-wrap gap-2">
      {value.map((chip, index) => {
        const category = chip.id ? byId.get(chip.id) : undefined;
        const parentCategory = !chip.id && chip.parentId ? byId.get(chip.parentId) : undefined;
        const label = category ? path(category) : parentCategory ? `${path(parentCategory)} / ${chip.name}` : chip.name;
        return <li key={chip.id ?? `new-${index}`} className="space-y-2">
          <Badge variant="secondary" className="h-auto min-h-7 gap-1 px-3 text-sm">
            {label}{!chip.id ? ` (${t(chip.parentId === undefined ? "categories.unresolved" : "categories.pending")})` : ""}
            {disabled ? null : <Button type="button" variant="ghost" size="icon-xs"
              aria-label={t("categories.removeAria", { name: label })} className="-mr-2 rounded-full text-muted-foreground"
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}><X /></Button>}
          </Badge>
          {!chip.id && chip.parentId === undefined && !disabled ? <SelectField
            label={t("categories.resolveSuggestion", { name: chip.name })} value={null} onChange={(choice) => {
              if (!choice) return;
              const next = [...value];
              if (choice.startsWith("existing:")) {
                const id = choice.slice(9);
                const existing = byId.get(id);
                if (!existing) return;
                next[index] = { id, name: localize(existing.name) };
              } else {
                const parentId = choice === "new:root" ? null : choice.slice(4);
                const conflict = categories.some((item) => item.parentId === parentId && item.name.en.toLowerCase() === chip.name.trim().toLowerCase())
                  || value.some((item, otherIndex) => otherIndex !== index && !item.id && item.parentId === parentId && item.name.trim().toLowerCase() === chip.name.trim().toLowerCase());
                if (conflict) { setError(t("categories.siblingExists")); return; }
                next[index] = { name: chip.name, parentId };
              }
              setError(null);
              onChange(next.filter((item, itemIndex, all) => !item.id || all.findIndex((other) => other.id === item.id) === itemIndex));
            }} options={[
              ...categories.map((item) => ({ value: `existing:${item.id}`, label: path(item) })),
              { value: "new:root", label: t("categories.createUnder", { parent: t("categories.root") }) },
              ...categories.map((item) => ({ value: `new:${item.id}`, label: t("categories.createUnder", { parent: path(item) }) })),
            ]} /> : null}
        </li>;
      })}
    </ul>
    {!disabled ? <>
      {error && !creating ? <ErrorAlert message={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <CategoryTreeFilter mode="assignment" maxSelected={Math.max(0, maxCategories - (value.length - selected.length))}
          selected={selected} onChange={(ids) => onChange([
            ...ids.map((id) => ({ id, name: byId.get(id) ? localize(byId.get(id)!.name) : value.find((chip) => chip.id === id)?.name ?? id })),
            ...value.filter((chip) => !chip.id),
          ])} />
        {!creating ? <Button type="button" variant="outline" onClick={() => setCreating(true)}><Plus />{t("categories.createCategory")}</Button> : null}
      </div>
      {creating ? <div className="flex flex-col gap-3 rounded-lg border p-3">
        <ErrorAlert message={error} />
        <FormField label={t("common.nameEnglish")} value={draft} onChange={setDraft} maxLength={100} required />
        <SelectField label={t("categories.parent")} value={parent} onChange={setParent} required
          options={[{ value: "__root__", label: t("categories.root") }, ...categories.map((category) => ({ value: category.id, label: path(category) }))]} />
        <p className="text-sm text-muted-foreground">{t("categories.pendingHint")}</p>
        <div className="flex gap-6">
          <Button type="button" onClick={addDraft} disabled={!draft.trim() || parent === null || !query.isSuccess}>{t("categories.add")}</Button>
          <Button type="button" variant="outline" onClick={() => { setCreating(false); setError(null); }}>{t("common.cancel")}</Button>
        </div>
      </div> : null}
    </> : null}
  </div>;
}
