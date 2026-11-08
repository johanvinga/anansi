import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import type { AttributeDataType, AttributeField, AttributeSetDetail } from "../../api/types";
import { CheckboxField } from "../../components/checkbox-field";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { SelectField, type SelectOption } from "../../components/select-field";

const DATA_TYPES: SelectOption[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number (whole)" },
  { value: "decimal", label: "Decimal" },
  { value: "boolean", label: "Yes / no" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select (one option)" },
];

interface OptionRow {
  key: string;
  id?: string;
  label: string;
}

interface FieldDialogProps {
  attributeSetId: string;
  /** When set, the dialog edits this field; otherwise it creates a new one. */
  field?: AttributeField;
  onClose: () => void;
  onSaved: (detail: AttributeSetDetail) => void;
}

let rowKey = 0;
const nextKey = () => `row-${(rowKey += 1)}`;

/** Create or edit an attribute field (FR-ATS-03/04/06). The data type is locked once products have values (FR-ATS-07). */
export function FieldDialog({ attributeSetId, field, onClose, onSaved }: FieldDialogProps) {
  const [name, setName] = useState(field?.name ?? "");
  const [dataType, setDataType] = useState<AttributeDataType>(field?.dataType ?? "text");
  const [unit, setUnit] = useState(field?.unit ?? "");
  const [isRequired, setIsRequired] = useState(field?.isRequired ?? false);
  const [options, setOptions] = useState<OptionRow[]>(
    field?.options.length ? field.options.map((o) => ({ key: nextKey(), id: o.id, label: o.label })) : [{ key: nextKey(), label: "" }],
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const typeLocked = Boolean(field?.hasValues);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const filledOptions = options.filter((o) => o.label.trim());
    try {
      const result = field
        ? await apiRequest<{ attributeSet: AttributeSetDetail }>("PUT", `/attribute-sets/${attributeSetId}/fields/${field.id}`, {
            name,
            dataType: typeLocked ? undefined : dataType,
            unit: unit.trim() || null,
            isRequired,
            options: dataType === "select" ? filledOptions.map((o) => ({ id: o.id, label: o.label })) : undefined,
          })
        : await apiRequest<{ attributeSet: AttributeSetDetail }>("POST", `/attribute-sets/${attributeSetId}/fields`, {
            name,
            dataType,
            unit: unit.trim() || null,
            isRequired,
            options: dataType === "select" ? filledOptions.map((o) => o.label) : undefined,
          });
      onSaved(result.attributeSet);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  const optionsError = error?.fieldError("options") ?? error?.details.find((d) => d.field?.startsWith("options."))?.message;

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{field ? `Edit ${field.name}` : "Add field"}</DialogTitle>
            {field ? <DialogDescription>Code: {field.code}</DialogDescription> : null}
          </DialogHeader>
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <FormField label="Name" name="name" value={name} onChange={setName} required error={error?.fieldError("name")} />
            <SelectField
              label="Data type"
              options={DATA_TYPES}
              value={dataType}
              onChange={(value) => value && setDataType(value as AttributeDataType)}
              disabled={typeLocked}
              required
              helperText={typeLocked ? "Locked because products already have values for this field." : undefined}
              error={error?.fieldError("dataType")}
            />
            <FormField
              label="Unit (optional)"
              name="unit"
              value={unit}
              onChange={setUnit}
              helperText="For example mm. Shown next to the value; not used for conversion."
              error={error?.fieldError("unit")}
            />
            <CheckboxField label="Required" checked={isRequired} onChange={setIsRequired} />

            {dataType === "select" ? (
              <FieldSet>
                <FieldLegend variant="label">Options</FieldLegend>
                <div className="flex flex-col gap-3">
                  {options.map((option, index) => (
                    <div key={option.key} className="flex items-end gap-2">
                      <div className="flex-1">
                        <FormField
                          label={`Option ${index + 1}`}
                          value={option.label}
                          onChange={(label) => setOptions(options.map((o) => (o.key === option.key ? { ...o, label } : o)))}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Remove option ${index + 1}`}
                        onClick={() => setOptions(options.filter((o) => o.key !== option.key))}
                        disabled={options.length === 1}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOptions([...options, { key: nextKey(), label: "" }])}
                  >
                    <Plus />
                    Add option
                  </Button>
                </div>
                {optionsError ? <FieldError>{optionsError}</FieldError> : null}
              </FieldSet>
            ) : null}
          </FieldGroup>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : field ? "Save field" : "Add field"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
