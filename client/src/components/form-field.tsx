import { useId } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
  type?: "text" | "email" | "password" | "date" | "number";
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
  error?: string | undefined;
  maxLength?: number;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** Labeled, validated text input built on shadcn's Field and Input. */
export function FormField({
  label,
  value,
  onChange,
  name,
  type = "text",
  autoComplete,
  required,
  disabled,
  helperText,
  error,
  maxLength,
  onKeyDown,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hasHint = Boolean(error ?? helperText);

  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true" className="text-destructive">*</span> : null}
      </FieldLabel>
      <Input
        id={id}
        name={name}
        type={type}
        value={value}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={hasHint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error ? (
        <FieldError id={hintId}>{error}</FieldError>
      ) : helperText ? (
        <FieldDescription id={hintId}>{helperText}</FieldDescription>
      ) : null}
    </Field>
  );
}
