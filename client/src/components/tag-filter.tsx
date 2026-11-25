import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { apiRequest, errorMessage } from "../api/client";
import { localize } from "../api/translations";
import type { Tag } from "../api/types";
import { ErrorAlert } from "./error-alert";

interface TagFilterProps {
  selected: string[];
  onChange: (selected: string[]) => void;
  uncategorized?: boolean;
  onUncategorizedChange?: (value: boolean) => void;
}

export function TagFilter({ selected, onChange, uncategorized = false, onUncategorizedChange }: TagFilterProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["tags"],
    queryFn: async () => (await apiRequest<{ items: Tag[] }>("GET", "/tags")).items,
  });
  const tags = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (query.data ?? []).filter((tag) =>
      !needle ||
      tag.name.en.toLocaleLowerCase().includes(needle) ||
      tag.name.fr.toLocaleLowerCase().includes(needle),
    );
  }, [query.data, search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline">
          <Filter />
          Tags{selected.length ? ` (${selected.length})` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[90vw]">
        <p className="font-medium">Filter by tags</p>
        <Input
          aria-label="Search tags"
          placeholder="Search tags"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {query.isLoading ? <p role="status">Loading...</p> : null}
        {query.isError ? <ErrorAlert message={errorMessage(query.error)} /> : null}
        <div className="mt-3 max-h-64 space-y-1 overflow-auto">
          {tags.map((tag) => (
            <label key={tag.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm">
              <Checkbox
                checked={selected.includes(tag.id)}
                onCheckedChange={(checked) => {
                  onChange(checked === true
                    ? [...new Set([...selected, tag.id])]
                    : selected.filter((id) => id !== tag.id));
                }}
              />
              {localize(tag.name)}
            </label>
          ))}
        </div>
        {onUncategorizedChange ? (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <Checkbox
              checked={uncategorized}
              onCheckedChange={(checked) => onUncategorizedChange(checked === true)}
            />
            Untagged
          </label>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => {
          onChange([]);
          onUncategorizedChange?.(false);
        }}>
          Clear
        </Button>
      </PopoverContent>
    </Popover>
  );
}
