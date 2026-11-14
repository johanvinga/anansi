import { useId } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Upload } from "lucide-react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatSize } from "../api/format";

interface AssetFileFieldProps {
  file: File | null;
  onChange: (file: File | null) => void;
  resetKey?: number;
}

export function AssetFileField({ file, onChange, resetKey }: AssetFileFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}><Upload className="size-4" />{t("suppliers.assetFile")}</FieldLabel>
      <Input key={resetKey} id={id} type="file" onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
      {file ? (
        <FieldDescription className="flex items-center gap-2">
          <FileText className="size-4" />
          <span className="truncate">{file.name}</span>
          <span>· {formatSize(file.size)}</span>
        </FieldDescription>
      ) : <FieldDescription>{t("suppliers.anyFileType")}</FieldDescription>}
    </Field>
  );
}
