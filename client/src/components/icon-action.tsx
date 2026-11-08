import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface IconActionProps {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  /** Renders a link instead of a button, for downloads. */
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
}

/** Icon-only row action with a tooltip and an accessible label. */
export function IconAction({ label, icon: Icon, onClick, href, destructive, disabled }: IconActionProps) {
  const className = cn(destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Button asChild variant="ghost" size="icon-sm" className={className}>
            <a href={href} aria-label={label}>
              <Icon />
            </a>
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={className}
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
          >
            <Icon />
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
