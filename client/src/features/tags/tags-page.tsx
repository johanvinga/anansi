import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, errorMessage } from "../../api/client";
import { localize } from "../../api/translations";
import type { Page, Tag } from "../../api/types";
import { ErrorAlert } from "../../components/error-alert";
import { FormField } from "../../components/form-field";
import { PageLayout } from "../../components/page-layout";
import { PaginationControls } from "../../components/pagination-controls";
import { usePagedList, usePageClamp } from "../../lib/use-paged-list";

interface TagsPageProps {
  isAdmin: boolean;
}

export function TagsPage({ isAdmin }: TagsPageProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [nameEn, setNameEn] = useState("");
  const [nameFr, setNameFr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const list = usePagedList();
  const { page, pageSize } = list;
  const tags = useQuery({
    queryKey: ["tags", "list", { page, pageSize }],
    queryFn: () => apiRequest<Page<Tag>>("GET", `/tags?page=${page}&pageSize=${pageSize}`),
    placeholderData: keepPreviousData,
  });
  usePageClamp(list, tags.data?.total);

  async function createTag(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("POST", "/tags", { name: { en: nameEn, fr: nameFr || nameEn } });
      setCreating(false);
      setNameEn("");
      setNameFr("");
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageLayout
      title="Tags"
      toolbar={isAdmin ? <Button onClick={() => setCreating(true)}><Plus />Create tag</Button> : undefined}
    >
      <ErrorAlert message={error ?? (tags.error ? errorMessage(tags.error) : null)} />
      <Table>
        <TableHeader><TableRow><TableHead>Tag</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
        <TableBody>
          {tags.data?.items.map((tag) => (
            <TableRow key={tag.id}>
              <TableCell>{localize(tag.name)}</TableCell>
              <TableCell>{tag.isArchived ? "Archived" : "Active"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {tags.data ? (
        <PaginationControls total={tags.data.total} pageSize={pageSize} page={page} onPageChange={list.setPage} />
      ) : null}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form onSubmit={createTag} className="flex flex-col gap-4">
            <DialogHeader><DialogTitle>Create tag</DialogTitle></DialogHeader>
            <FormField label="English name" value={nameEn} onChange={setNameEn} required maxLength={100} />
            <FormField label="French name" value={nameFr} onChange={setNameFr} required maxLength={100} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" disabled={submitting || !nameEn.trim() || !nameFr.trim()}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
