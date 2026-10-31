import { Field } from "@ark-ui/react/field";
import { useState, type KeyboardEvent } from "react";
import type { CategoryChip } from "./category-chips";

interface CategoryEditorProps {
  value: CategoryChip[];
  onChange: (value: CategoryChip[]) => void;
  disabled?: boolean;
}

/** Chip list with an add field. Rendered inside other forms, so it must not contain a <form>. */
export function CategoryEditor({ value, onChange, disabled }: CategoryEditorProps) {
  const [draft, setDraft] = useState("");

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
    <div className="category-editor">
      {value.length === 0 ? <p className="helper-text">No categories assigned.</p> : null}
      <ul className="chip-list" aria-label="Categories">
        {value.map((chip) => (
          <li key={chip.id ?? `new-${chip.name}`} className="chip">
            <span>{chip.name}</span>
            {disabled ? null : (
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${chip.name}`}
                onClick={() => onChange(value.filter((c) => c !== chip))}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <div className="toolbar">
          <Field.Root className="field">
            <Field.Label>Add category</Field.Label>
            <Field.Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={100}
            />
            <Field.HelperText>Type an existing name to reuse it, or a new name to create it.</Field.HelperText>
          </Field.Root>
          <button type="button" className="secondary-button" onClick={addDraft}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}
