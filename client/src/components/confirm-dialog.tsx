import { Dialog } from "@ark-ui/react/dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation step for destructive actions (FR-UI-04). */
export function ConfirmDialog({ open, title, description, confirmLabel, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(details) => !details.open && onCancel()}>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Positioner className="dialog-positioner">
        <Dialog.Content className="card dialog">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <div className="dialog-actions">
            <Dialog.CloseTrigger className="secondary-button">Cancel</Dialog.CloseTrigger>
            <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
