import { useTranslation } from "react-i18next";
import { localize } from "../../api/translations";
import type { AttributeField, AttributeValue } from "../../api/types";
import { CheckboxField } from "../../components/checkbox-field";
import { FormField } from "../../components/form-field";
import { SelectField } from "../../components/select-field";

interface AttributeInputProps {
  field: AttributeField;
  value: AttributeValue;
  onChange: (value: AttributeValue) => void;
  error?: string | undefined;
}

/** Renders the input that matches a field's data type (FR-PRD-05). */
export function AttributeInput({ field, value, onChange, error }: AttributeInputProps) {
  const { t } = useTranslation();
  const fieldName = localize(field.name);
  const label = field.unit ? `${fieldName} (${field.unit})` : fieldName;
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";

  switch (field.dataType) {
    case "boolean":
      return <CheckboxField label={label} checked={value === true} onChange={onChange} error={error} />;
    case "select":
      return (
        <SelectField
          label={label}
          required={field.isRequired}
          value={text || null}
          onChange={(next) => onChange(next)}
          options={[
            ...(field.isRequired ? [] : [{ value: "", label: "— None —" }]),
            ...field.options.map((o) => ({ value: o.id, label: localize(o.label) })),
          ]}
          error={error}
        />
      );
    case "date":
      return <FormField label={label} type="date" value={text} onChange={onChange} required={field.isRequired} error={error} />;
    case "number":
      return (
        <FormField
          label={label}
          type="number"
          value={text}
          onChange={onChange}
          required={field.isRequired}
          helperText={t("products.wholeNumber")}
          error={error}
        />
      );
    case "decimal":
      return (
        <FormField
          label={label}
          value={text}
          onChange={onChange}
          required={field.isRequired}
          helperText={t("products.decimals4")}
          error={error}
        />
      );
    case "text":
      return <FormField label={label} value={text} onChange={onChange} required={field.isRequired} error={error} />;
  }
}
