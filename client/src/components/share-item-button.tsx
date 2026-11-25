import { useState } from "react";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PinnedItemType } from "../api/types";
import { Button } from "./ui/button";
import { ShareItemDialog } from "./share-item-dialog";

interface ShareItemButtonProps {
  itemType: PinnedItemType;
  itemId: string;
  itemName: string;
  iconOnly?: boolean;
  onSaved?: () => void;
}

export function ShareItemButton({
  itemType,
  itemId,
  itemName,
  iconOnly = false,
  onSaved,
}: ShareItemButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      {iconOnly ? (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("pins.share")} onClick={() => setOpen(true)}>
          <Share2 />
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Share2 />
          {t("pins.share")}
        </Button>
      )}
      <ShareItemDialog
        open={open}
        onOpenChange={setOpen}
        itemType={itemType}
        itemId={itemId}
        itemName={itemName}
        onSaved={onSaved}
      />
    </>
  );
}
