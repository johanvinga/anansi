import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest, errorMessage } from "../api/client";
import type { PinnedItemType, ShareUserSummary } from "../api/types";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { ErrorAlert } from "./error-alert";
import { MultiSelect } from "./multi-select";

interface ShareItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemType: PinnedItemType;
  itemId: string;
  itemName: string;
  recipientIds?: string[];
  note?: string | null;
  onSaved?: () => void;
}

export function ShareItemDialog({
  open,
  onOpenChange,
  itemType,
  itemId,
  itemName,
  recipientIds: initialRecipientIds = [],
  note: initialNote = null,
  onSaved,
}: ShareItemDialogProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<ShareUserSummary[]>([]);
  const [recipientIds, setRecipientIds] = useState(initialRecipientIds);
  const [note, setNote] = useState(initialNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void apiRequest<{ users: ShareUserSummary[] }>("GET", "/pins/users")
      .then((result) => setUsers(result.users))
      .catch((caught) => setError(errorMessage(caught)));
  }, [open, initialRecipientIds, initialNote]);

  async function save() {
    if (recipientIds.length === 0) {
      setError(t("pins.selectRecipients"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest("POST", "/shares", {
        itemType,
        itemId,
        recipientIds,
        note: note.trim() || null,
      });
      onOpenChange(false);
      onSaved?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pins.shareTitle", { name: itemName })}</DialogTitle>
          <DialogDescription>{t("pins.shareDescription")}</DialogDescription>
        </DialogHeader>
        {error ? <ErrorAlert message={error} /> : null}
        <div className="space-y-4">
          <MultiSelect
            label={t("pins.recipients")}
            options={users.map((user) => ({
              value: user.id,
              label: user.displayName ? `${user.displayName} (${user.email})` : user.email,
            }))}
            value={recipientIds}
            onChange={setRecipientIds}
            placeholder={t("pins.selectRecipients")}
          />
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="share-note">{t("pins.note")}</label>
            <Textarea
              id="share-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              placeholder={t("pins.notePlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{note.length}/500</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving || recipientIds.length === 0}>
            {t("pins.share")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
