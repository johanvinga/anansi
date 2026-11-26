import { useEffect, useState } from "react";
import { Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiRequest, errorMessage } from "../api/client";
import type { PinnedItemType } from "../api/types";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";

interface PinItemButtonProps {
  itemType: PinnedItemType;
  itemId: string;
  label: string;
  /** Known pinned state from a list response; skips the status request. */
  initialPinned?: boolean;
  onChange?: () => void;
}

export function PinItemButton({ itemType, itemId, label, initialPinned, onChange }: PinItemButtonProps) {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState(initialPinned ?? false);
  const [syncedInitial, setSyncedInitial] = useState(initialPinned);
  const [busy, setBusy] = useState(false);
  if (syncedInitial !== initialPinned) {
    setSyncedInitial(initialPinned);
    if (initialPinned !== undefined) setPinned(initialPinned);
  }

  useEffect(() => {
    if (initialPinned !== undefined) return;
    void apiRequest<{ pinned: boolean }>("GET", `/pins/${itemType}/${itemId}/status`)
      .then((result) => setPinned(result.pinned))
      .catch(() => setPinned(false));
  }, [itemType, itemId, initialPinned]);

  async function toggle() {
    if (busy) return;
    const previous = pinned;
    setBusy(true);
    setPinned(!previous);
    try {
      const result = await apiRequest<{ pinned: boolean }>(
        previous ? "DELETE" : "POST",
        "/pins",
        { itemType, itemId },
      );
      setPinned(result.pinned);
      onChange?.();
    } catch (error) {
      setPinned(previous);
      void errorMessage(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={pinned ? "default" : "ghost"}
          size="icon-sm"
          aria-label={pinned ? t("pins.unpinAria", { name: label }) : t("pins.pinAria", { name: label })}
          aria-pressed={pinned}
          disabled={busy}
          onClick={() => void toggle()}
          className={cn(pinned && "text-primary-foreground")}
        >
          <Pin className={pinned ? "fill-current" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {pinned ? t("pins.unpinAria", { name: label }) : t("pins.pinAria", { name: label })}
      </TooltipContent>
    </Tooltip>
  );
}
