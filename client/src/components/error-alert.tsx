import { CircleAlert, CircleCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface ErrorAlertProps {
  message: string | null | undefined;
}

/** Inline error message for forms and lists. Renders nothing when there is no message. */
export function ErrorAlert({ message }: ErrorAlertProps) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

interface SuccessAlertProps {
  message: string;
}

/** Inline confirmation message, announced politely to screen readers. */
export function SuccessAlert({ message }: SuccessAlertProps) {
  return (
    <Alert role="status" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
      <CircleCheck />
      <AlertDescription className="text-inherit">{message}</AlertDescription>
    </Alert>
  );
}
