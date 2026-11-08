import { useId } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps {
  label: string;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
  error?: string | undefined;
  hideLabel?: boolean;
}

// Radix Select reserves the empty string for "no selection", so an explicit empty option gets a stand-in value.
const EMPTY_VALUE = "__empty__";

/** Labeled single-choice select built on shadcn's Field and Select. */
export function SelectField({
  label,
  options,
  value,
  onChange,
  placeholder = "Select…",
  required,
  disabled,
  helperText,
  error,
  hideLabel,
}: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const toItemValue = (v: string) => (v === "" ? EMPTY_VALUE : v);
  const hasEmptyOption = options.some((option) => option.value === "");
  const selected = value === null || (value === "" && !hasEmptyOption) ? "" : toItemValue(value);

  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled ? true : undefined}>
      <FieldLabel htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {required ? <span aria-hidden="true" className="text-destructive">*</span> : null}
      </FieldLabel>
      <Select
        value={selected}
        onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)}
        disabled={disabled}
        required={required}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={error ? true : undefined}
          aria-describedby={error || helperText ? hintId : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={toItemValue(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <FieldError id={hintId}>{error}</FieldError>
      ) : helperText ? (
        <FieldDescription id={hintId}>{helperText}</FieldDescription>
      ) : null}
    </Field>
  );
}
