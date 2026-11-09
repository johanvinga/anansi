import { useState, type FormEvent } from "react";
import { Boxes } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, errorMessage } from "../../api/client";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { LanguageSwitcher } from "../../i18n/language-switcher";

export function LoginPage() {
  const { login } = useAuth();
  const { t } = useTranslation();
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
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center justify-center gap-2 font-semibold">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="size-4" />
          </div>
          {t("nav.appName")}
        </div>
        <Card className="gap-6 py-6">
          <CardHeader className="px-6 text-center">
            <CardTitle className="text-xl">
              <h1>{t("auth.signInTitle")}</h1>
            </CardTitle>
            <CardDescription>{t("auth.signInDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="px-6">
            <form onSubmit={handleSubmit} noValidate>
              <FieldGroup>
                <ErrorAlert message={error} />
                <FormField
                  label={t("auth.email")}
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={setEmail}
                  required
                />
                <FormField
                  label={t("auth.password")}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  required
                />
                <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                  {submitting ? <Spinner /> : null}
                  {submitting ? t("auth.signingIn") : t("auth.signIn")}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <div className="flex justify-center">
          <LanguageSwitcher />
        </div>
      </div>
    </main>
  );
}
