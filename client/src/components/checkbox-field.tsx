import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  error?: string | undefined;
}

/** Labeled checkbox built on shadcn's Field and Checkbox. */
export function CheckboxField({ label, checked, onChange, disabled, error }: CheckboxFieldProps) {
  const id = useId();
  return (
    <Field orientation="horizontal" data-invalid={error ? true : undefined} data-disabled={disabled ? true : undefined}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
      />
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
