import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Eye, Plus, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { AttributeSetDetail, AttributeSetSummary } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { ErrorAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PageHeader } from "../../components/page-header";
import { TableEmptyRow } from "../../components/table-empty-row";
import { AttributeSetBuilder } from "./attribute-set-builder";

export function AttributeSetsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const newSetId = useId();
  const [sets, setSets] = useState<AttributeSetSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const result = await apiRequest<{ items: AttributeSetSummary[] }>("GET", "/attribute-sets");
      setSets(result.items);
      setLoaded(true);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(undefined);
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>("POST", "/attribute-sets", { name: { en: newName } });
      setNewName("");
      navigate(`/attribute-sets/${result.attributeSet.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? (err.fieldError("name") ?? err.message) : errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader title={t("attributeSets.title")} breadcrumbs={[{ label: t("attributeSets.title") }]} />

      <Card className="gap-0 py-0">
        {isAdmin ? (
          <form className="flex flex-wrap items-start justify-end gap-2 p-4" onSubmit={(event) => void handleCreate(event)} noValidate>
            <Field data-invalid={createError ? true : undefined} className="w-64">
              <FieldLabel htmlFor={newSetId} className="sr-only">
                {t("attributeSets.createSet")}
              </FieldLabel>
              <Input
                id={newSetId}
                name="newSet"
                placeholder={t("attributeSets.createSet")}
                required
                value={newName}
                aria-invalid={createError ? true : undefined}
                onChange={(event) => setNewName(event.target.value)}
              />
              {createError ? <FieldError>{createError}</FieldError> : null}
            </Field>
            <Button type="submit" size="lg" disabled={!newName.trim()}>
              <Plus />
              {t("attributeSets.createSetButton")}
            </Button>
          </form>
        ) : null}

        {error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={error} />
          </div>
        ) : null}

        <Table aria-label="Attribute sets">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="pl-4">{t("suppliers.name")}</TableHead>
              <TableHead className="text-right">{t("attributeSets.fields")}</TableHead>
              <TableHead className="text-right">{t("attributeSets.products")}</TableHead>
              <TableHead className="pr-4 text-right">{t("suppliers.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loaded && sets.length === 0 ? <TableEmptyRow colSpan={4} message="No attribute sets yet." /> : null}
            {sets.map((set) => (
              <TableRow key={set.id}>
                <TableCell className="pl-4 font-medium">
                  <Link to={`/attribute-sets/${set.id}`} className="hover:underline">
                    {localize(set.name)}
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  <Badge variant="secondary">{set.fieldCount}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Badge variant={set.productCount > 0 ? "info" : "secondary"}>{set.productCount}</Badge>
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <IconAction
                    label={isAdmin ? `Open builder for ${localize(set.name)}` : `View ${localize(set.name)}`}
                    icon={isAdmin ? Settings2 : Eye}
                    onClick={() => navigate(`/attribute-sets/${set.id}`)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

export function AttributeSetBuilderPage() {
  const { user } = useAuth();
  const { attributeSetId } = useParams<{ attributeSetId: string }>();
  const navigate = useNavigate();

  if (!attributeSetId) {
    return <Navigate to="/attribute-sets" replace />;
  }

  return (
    <AttributeSetBuilder
      attributeSetId={attributeSetId}
      isAdmin={user?.role === "admin"}
      onBack={() => navigate("/attribute-sets")}
      onDeleted={() => navigate("/attribute-sets", { replace: true })}
    />
  );
}
