import { useId, useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatSize } from "../api/format";

interface PdfFileFieldProps {
  file: File | null;
  onChange: (file: File | null) => void;
  /** Bumping this value clears the native input after a successful upload. */
  resetKey?: number;
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Single PDF picker built on shadcn's Input. Rejects other file types before upload. */
export function PdfFileField({ file, onChange, resetKey }: PdfFileFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rejection, setRejection] = useState<string | null>(null);

  function handleFiles(list: FileList | null) {
    const picked = list?.[0] ?? null;
    if (list && list.length > 1) {
      setRejection("Upload one file at a time.");
      onChange(null);
      return;
    }
    if (picked && !isPdf(picked)) {
      setRejection("Only PDF files can be uploaded.");
      onChange(null);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setRejection(null);
    onChange(picked);
  }

  return (
    <Field data-invalid={rejection ? true : undefined}>
      <FieldLabel htmlFor={id}>
        <Upload className="size-4" />
        PDF file
      </FieldLabel>
      <Input
        key={resetKey}
        ref={inputRef}
        id={id}
        type="file"
        accept="application/pdf,.pdf"
        aria-invalid={rejection ? true : undefined}
        onChange={(event) => handleFiles(event.target.files)}
      />
      {rejection ? (
        <FieldError>{rejection}</FieldError>
      ) : file ? (
        <FieldDescription className="flex items-center gap-2">
          <FileText className="size-4" />
          <span className="truncate">{file.name}</span>
          <span>· {formatSize(file.size)}</span>
        </FieldDescription>
      ) : (
        <FieldDescription>PDF files only.</FieldDescription>
      )}
    </Field>
  );
}
