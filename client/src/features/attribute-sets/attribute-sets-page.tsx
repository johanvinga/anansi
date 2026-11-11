import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Eye, Plus, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { FieldGroup } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { AttributeSetDetail, AttributeSetSummary } from "../../api/types";
import { useAuth } from "../../auth/auth-state";
import { FormField } from "../../components/form-field";
import { ErrorAlert } from "../../components/error-alert";
import { IconAction } from "../../components/icon-action";
import { PageLayout } from "../../components/page-layout";
import { TableEmptyRow } from "../../components/table-empty-row";
import { AttributeSetBuilder } from "./attribute-set-builder";

export function AttributeSetsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();

  const setsQuery = useQuery({
    queryKey: ["attribute-sets"],
    queryFn: async () => (await apiRequest<{ items: AttributeSetSummary[] }>("GET", "/attribute-sets")).items,
  });
  const sets = setsQuery.data ?? [];
  const loaded = setsQuery.isSuccess;

  return (
    <>
      <PageLayout
        title={t("attributeSets.title")}
        breadcrumbs={[{ label: t("attributeSets.title") }]}
        toolbar={
          isAdmin ? (
            <Button className="ml-auto" size="lg" onClick={() => setCreateOpen(true)}>
              <Plus />
              {t("attributeSets.createSetButton")}
            </Button>
          ) : null
        }
      >

        {setsQuery.error ? (
          <div className="px-4 pb-4">
            <ErrorAlert message={errorMessage(setsQuery.error)} />
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
      </PageLayout>

      {createOpen ? (
        <CreateAttributeSetDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["attribute-sets"] });
            navigate(`/attribute-sets/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

interface CreateAttributeSetDialogProps {
  onClose: () => void;
  onCreated: (id: string) => void;
}

function CreateAttributeSetDialog({ onClose, onCreated }: CreateAttributeSetDialogProps) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState("");
  const [nameFr, setNameFr] = useState("");
  const [nameFrEdited, setNameFrEdited] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function changeEnglishName(value: string) {
    setNameEn(value);
    if (!nameFrEdited) setNameFr(value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await apiRequest<{ attributeSet: AttributeSetDetail }>(
        "POST",
        "/attribute-sets",
        { name: { en: nameEn, fr: nameFr } },
      );
      onCreated(result.attributeSet.id);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", errorMessage(err)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t("attributeSets.createSetTitle")}</DialogTitle>
            <DialogDescription>{t("attributeSets.createSetDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {error && error.details.length === 0 ? <ErrorAlert message={error.message} /> : null}
            <FormField
              label={t("common.nameEnglish")}
              name="name.en"
              value={nameEn}
              onChange={changeEnglishName}
              required
              error={error?.fieldError("name.en")}
              maxLength={100}
            />
            <FormField
              label={t("common.nameFrench")}
              name="name.fr"
              value={nameFr}
              onChange={(value) => {
                setNameFr(value);
                setNameFrEdited(true);
              }}
              required
              error={error?.fieldError("name.fr")}
              maxLength={100}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || !nameEn.trim() || !nameFr.trim()}>
              {submitting ? t("common.saving") : t("attributeSets.createSetButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
