import { useState, type FormEvent } from "react";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { FormField } from "../../components/form-field";

interface ChangePasswordFormProps {
  onChanged: () => void;
}

/** Used both on the account page and when a password change is required (SPEC §8.4). */
export function ChangePasswordForm({ onChanged }: ChangePasswordFormProps) {
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

  return (
    <form className="card" onSubmit={handleSubmit} noValidate>
      <h2>Change password</h2>
      {formError ? (
        <p role="alert" className="form-error">
          {formError}
        </p>
      ) : null}
      {saved ? <p role="status">Your password has been changed.</p> : null}
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
      <button type="submit" className="primary-button" disabled={submitting}>
        {submitting ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
