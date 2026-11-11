import { useId, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  /** Selected option values. */
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Shown when nothing is selected and no placeholder is given. */
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
}

/** Multi-select built from shadcn's Popover and Command, with a search filter and removable chips. */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  disabled,
  className,
}: MultiSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedLabels = value
    .map((v) => options.find((option) => option.value === v)?.label)
    .filter((label): label is string => Boolean(label));
  const filtered = search
    ? options.filter((option) => option.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  function toggle(optionValue: string) {
    onChange(value.includes(optionValue) ? value.filter((v) => v !== optionValue) : [...value, optionValue]);
  }

  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            size="lg"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            disabled={disabled}
            className="max-w-72 justify-start font-normal"
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-left">
              {selectedLabels.length === 0 ? (
                <span className="text-muted-foreground">{placeholder ?? label}</span>
              ) : (
                selectedLabels.map((itemLabel) => (
                  <Badge
                    key={itemLabel}
                    variant="secondary"
                    className="max-w-40"
                  >
                    <span className="truncate">{itemLabel}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove ${itemLabel}`}
                      className="cursor-pointer rounded-sm opacity-70 hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        const option = options.find((o) => o.label === itemLabel);
                        if (option) onChange(value.filter((v) => v !== option.value));
                      }}
                    >
                      <X className="size-3" />
                    </span>
                  </Badge>
                ))
              )}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <div className="border-b p-1">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={searchPlaceholder ?? "Search…"}
                className="h-8 w-full rounded-lg bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup>
                {filtered.map((option) => {
                  const active = value.includes(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => toggle(option.value)}
                      data-checked={active}
                    >
                      <Check className={cn(active ? "opacity-100" : "opacity-0")} />
                      {option.label}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
