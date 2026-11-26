import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, ChevronRight, Package, Plus, Truck, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { CatalogAnalysisStatus, DashboardSharedItem, PinnedItemType, RecentCatalogView } from "../../api/types";
import { formatTime } from "../../api/format";
import { localize } from "../../api/translations";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PinItemButton } from "../../components/pin-item-button";
import { cn } from "../../lib/utils";

const TONES = [
  "bg-[#ece6d6] text-[#5b5340] dark:bg-white/10 dark:text-foreground",
  "bg-[#dfe7d4] text-[#445139] dark:bg-white/10 dark:text-foreground",
  "bg-[#dde3e6] text-[#44535b] dark:bg-white/10 dark:text-foreground",
  "bg-[#f0e1d6] text-[#6a4c39] dark:bg-white/10 dark:text-foreground",
];

/** Stable pastel per id so the same item always keeps its colour. */
function toneFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

function itemPath(item: Pick<DashboardSharedItem, "itemType" | "itemId">): string {
  if (item.itemType === "catalog") return `/catalogs/${item.itemId}/workspace`;
  if (item.itemType === "supplier") return `/suppliers/${item.itemId}`;
  return `/products/${item.itemId}`;
}

function ItemIcon({ type, className = "size-5" }: { type: PinnedItemType; className?: string }) {
  if (type === "catalog") return <BookOpen className={className} />;
  if (type === "supplier") return <Truck className={className} />;
  return <Package className={className} />;
}

interface StatCardProps {
  title: string;
  value: string;
  tagline: string;
  footer: ReactNode;
  icon: LucideIcon;
  chipClassName?: string;
  featured?: boolean;
  onClick: () => void;
}

export function StatCard({ title, value, tagline, footer, icon: Icon, chipClassName, featured, onClick }: StatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex min-h-44 flex-col overflow-hidden rounded-xl p-5 text-left ring-1 ring-foreground/10 transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
        featured ? "bg-accent" : "bg-card",
      )}
    >
      {featured ? (
        <>
          <span aria-hidden className="pointer-events-none absolute -right-16 -bottom-24 size-64 rounded-full bg-primary/[0.04]" />
          <span aria-hidden className="pointer-events-none absolute -right-6 -bottom-32 size-56 rounded-full bg-primary/[0.04]" />
        </>
      ) : null}
      <span className="relative flex items-start justify-between gap-3">
        <span className="text-sm text-muted-foreground">{title}</span>
        <span className={cn("flex size-8 items-center justify-center rounded-lg text-muted-foreground", chipClassName)}>
          <Icon className="size-4" />
        </span>
      </span>
      <span className="relative mt-4 flex items-baseline gap-4">
        <span className="text-5xl font-light tabular-nums tracking-tight text-primary dark:text-foreground">{value}</span>
        <span className="text-sm text-muted-foreground">{tagline}</span>
      </span>
      <span className="relative mt-auto flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">{footer}</span>
        <ArrowRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function statusVariant(status: CatalogAnalysisStatus): "success" | "destructive" | "info" | "secondary" {
  if (status === "processed") return "success";
  if (status === "failed") return "destructive";
  if (status === "queued" || status === "processing") return "info";
  return "secondary";
}

interface RecentCatalogCardProps {
  catalog: RecentCatalogView;
  onPinChange: () => void;
}

export function RecentCatalogCard({ catalog, onPinChange }: RecentCatalogCardProps) {
  const { t } = useTranslation();
  const supplier = catalog.supplierName ?? t("catalogs.unassigned");
  const path = `/catalogs/${catalog.id}/workspace`;
  return (
    <li className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-shadow hover:shadow-md">
      <Link
        to={path}
        aria-label={catalog.name}
        className={cn("group relative block aspect-[16/10] overflow-hidden rounded-lg p-3", toneFor(catalog.id))}
      >
        <span className="block truncate text-[10px] font-medium tracking-[0.2em] uppercase opacity-80">{supplier}</span>
        <span aria-hidden className="absolute right-[18%] bottom-0 h-3/5 w-[22%] rounded-t-full bg-current opacity-15" />
        <span aria-hidden className="absolute right-[44%] bottom-0 h-2/5 w-[16%] rounded-t-full bg-current opacity-10" />
        <span className="absolute bottom-3 left-3 max-w-[60%] truncate text-lg font-medium">
          {catalog.version ?? <BookOpen className="size-6 opacity-70" />}
        </span>
        <ArrowUpRight className="absolute right-3 bottom-3 size-3.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </Link>
      <div className="flex items-start justify-between gap-2">
        <Link to={path} className="line-clamp-2 min-w-0 text-sm font-medium hover:underline">
          {catalog.name}
        </Link>
        <PinItemButton itemType="catalog" itemId={catalog.id} label={catalog.name} onChange={onPinChange} />
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {t("pins.type.catalog")} · <span className="text-primary dark:text-foreground">{supplier}</span>
      </p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <Badge variant={statusVariant(catalog.analysisStatus)}>
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {t(`catalogs.analysisStatus.${catalog.analysisStatus}`)}
        </Badge>
        <time dateTime={catalog.viewedAt} className="text-xs text-muted-foreground tabular-nums">
          {formatTime(catalog.viewedAt)}
        </time>
      </div>
    </li>
  );
}

interface DashboardRowProps {
  item: DashboardSharedItem;
  subtitle: string;
  date?: string | null;
  note?: string | null;
  /** Stacks actions under the text; used in the narrow side panel. */
  compact?: boolean;
  actions: ReactNode;
}

export function DashboardRow({ item, subtitle, date, note, compact, actions }: DashboardRowProps) {
  const { t } = useTranslation();
  const name = localize(item.name);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/50">
      <Link to={itemPath(item)} className="flex min-w-0 flex-1 items-center gap-3">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", toneFor(item.itemId))}>
          <ItemIcon type={item.itemType} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
          {note ? <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground italic">“{note}”</span> : null}
        </span>
      </Link>
      {date && !compact ? <span className="hidden text-xs text-muted-foreground tabular-nums sm:block">{date}</span> : null}
      <div className={cn("flex items-center", compact && "w-full justify-end")}>
        {actions}
        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
          <Link to={itemPath(item)} aria-label={`${t("pins.open")}: ${name}`}>
            <ChevronRight />
          </Link>
        </Button>
      </div>
    </li>
  );
}

export function SharedEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div aria-hidden className="relative mb-4 h-32 w-48">
        <span className="absolute inset-x-6 top-4 bottom-2 rounded-full bg-accent" />
        <span className="absolute top-6 left-1/2 flex h-24 w-20 -translate-x-1/2 rotate-6 items-center justify-center rounded-lg bg-card text-primary shadow-sm ring-1 ring-foreground/10">
          <BookOpen className="size-7" />
        </span>
        <span className="absolute top-5 left-3 flex size-7 items-center justify-center rounded-full bg-[#f0e1d6] text-[11px] font-medium text-[#6a4c39] ring-2 ring-card">M</span>
        <span className="absolute right-3 bottom-4 flex size-7 items-center justify-center rounded-full bg-[#dfe7d4] text-[11px] font-medium text-[#445139] ring-2 ring-card">A</span>
        <Plus className="absolute top-3 right-6 size-4 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{t("pins.emptyReceivedTitle")}</p>
      <p className="max-w-56 text-xs text-muted-foreground">{t("pins.emptyReceivedHint")}</p>
    </div>
  );
}
