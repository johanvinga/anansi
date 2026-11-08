import { useId, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CategoryChip } from "./category-chips";

interface CategoryEditorProps {
  value: CategoryChip[];
  onChange: (value: CategoryChip[]) => void;
  disabled?: boolean;
}

/** Chip list with an add field. Rendered inside other forms, so it must not contain a <form>. */
export function CategoryEditor({ value, onChange, disabled }: CategoryEditorProps) {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  function addDraft() {
    const name = draft.trim();
    if (!name) return;
    const exists = value.some((chip) => chip.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      onChange([...value, { name }]);
    }
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addDraft();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {value.length === 0 ? <p className="text-sm text-muted-foreground">No categories assigned.</p> : null}
      <ul aria-label="Categories" className="flex flex-wrap gap-2">
        {value.map((chip) => (
          <li key={chip.id ?? `new-${chip.name}`}>
            <Badge variant="secondary" className="h-7 gap-1 px-3 text-sm">
              {chip.name}
              {disabled ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${chip.name}`}
                  className="-mr-2 rounded-full text-muted-foreground"
                  onClick={() => onChange(value.filter((c) => c !== chip))}
                >
                  <X />
                </Button>
              )}
            </Badge>
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <Field>
          <FieldLabel htmlFor={inputId}>Add category</FieldLabel>
          <div className="flex gap-2">
            <Input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={100}
            />
            <Button type="button" variant="outline" onClick={addDraft}>
              <Plus />
              Add
            </Button>
          </div>
          <FieldDescription>Type an existing name to reuse it, or a new name to create it.</FieldDescription>
        </Field>
      )}
    </div>
  );
}
