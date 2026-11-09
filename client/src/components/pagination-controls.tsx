import { useTranslation } from "react-i18next";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

interface PaginationControlsProps {
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
}

function visiblePages(page: number, totalPages: number): (number | "gap")[] {
  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const result: (number | "gap")[] = [];
  for (const p of sorted) {
    const previous = result[result.length - 1];
    if (typeof previous === "number" && p - previous > 1) result.push("gap");
    result.push(p);
  }
  return result;
}

/** Page navigation for lists (FR-SUP-02). `total` is the item count; pages are derived from `pageSize`. */
export function PaginationControls({ total, pageSize, page, onPageChange }: PaginationControlsProps) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const go = (target: number) => (event: React.MouseEvent) => {
    event.preventDefault();
    if (target >= 1 && target <= totalPages && target !== page) onPageChange(target);
  };
  const disabledClass = "pointer-events-none opacity-50";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
      <p className="text-sm text-muted-foreground">
        {t("pagination.summary", { page, totalPages, total })}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              onClick={go(page - 1)}
              aria-disabled={page <= 1}
              className={cn(page <= 1 && disabledClass)}
            />
          </PaginationItem>
          {visiblePages(page, totalPages).map((item, index) => (
            <PaginationItem key={item === "gap" ? `gap-${index}` : item}>
              {item === "gap" ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink href="#" isActive={item === page} onClick={go(item)}>
                  {item}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              href="#"
              onClick={go(page + 1)}
              aria-disabled={page >= totalPages}
              className={cn(page >= totalPages && disabledClass)}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
