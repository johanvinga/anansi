import { Field } from "@ark-ui/react/field";

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
}

/** Labeled, validated text input built on Ark UI's Field. */
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
}: FormFieldProps) {
  return (
    <Field.Root className="field" invalid={Boolean(error)} required={required} disabled={disabled}>
      <Field.Label>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Field.Label>
      <Field.Input
        name={name}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
      {helperText && !error ? <Field.HelperText>{helperText}</Field.HelperText> : null}
      {error ? <Field.ErrorText>{error}</Field.ErrorText> : null}
    </Field.Root>
  );
}
