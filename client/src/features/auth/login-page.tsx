import { useState, type FormEvent } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { useAuth } from "../../auth/auth-state";
import { FormField } from "../../components/form-field";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? err.message : errorMessage(err));
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={handleSubmit} noValidate>
        <h1>Sign in</h1>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          required
        />
        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          required
        />
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
