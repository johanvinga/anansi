import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { ErrorAlert, SuccessAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";

interface ChangePasswordFormProps {
  onChanged: () => void;
  /** Renders without its own card, for use inside another card. */
  embedded?: boolean;
}

/** Used both on the account page and when a password change is required (SPEC §8.4). */
export function ChangePasswordForm({ onChanged, embedded }: ChangePasswordFormProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{ currentPassword?: string; newPassword?: string; confirmPassword?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    setFormError(null);
    if (newPassword !== confirmPassword) {
      setErrors({ confirmPassword: "The passwords do not match." });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await apiRequest<void>("POST", "/users/me/password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSaved(true);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.details.length > 0) {
        setErrors({
          currentPassword: err.fieldError("currentPassword"),
          newPassword: err.fieldError("newPassword"),
        });
      }
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const fields = (
    <FieldGroup>
      <ErrorAlert message={formError} />
      {saved ? <SuccessAlert message="Your password has been changed." /> : null}
      <FormField
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={setCurrentPassword}
        required
        error={errors.currentPassword}
      />
      <FormField
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={setNewPassword}
        required
        helperText="At least 12 characters."
        error={errors.newPassword}
      />
      <FormField
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        required
        error={errors.confirmPassword}
      />
    </FieldGroup>
  );

  const submit = (
    <Button type="submit" size="lg" disabled={submitting} className={embedded ? "w-full" : undefined}>
      {submitting ? "Saving…" : "Change password"}
    </Button>
  );

  if (embedded) {
    return (
      <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate aria-label="Change password">
        {fields}
        {submit}
      </form>
    );
  }

  return (
    <Card className="gap-6 py-6">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
        <CardHeader className="px-6">
          <CardTitle>
            <h2>Change password</h2>
          </CardTitle>
          <CardDescription>Enter your current password, then choose a new one.</CardDescription>
        </CardHeader>
        <CardContent className="px-6">{fields}</CardContent>
        <CardFooter className="justify-end border-t px-6 py-4">{submit}</CardFooter>
      </form>
    </Card>
  );
}
