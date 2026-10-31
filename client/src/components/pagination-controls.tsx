import { Pagination } from "@ark-ui/react/pagination";

interface PaginationControlsProps {
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
}

export function PaginationControls({ total, pageSize, page, onPageChange }: PaginationControlsProps) {
  return (
    <Pagination.Root
      className="pagination"
      count={total}
      pageSize={pageSize}
      page={page}
      onPageChange={(details) => onPageChange(details.page)}
    >
      <Pagination.PrevTrigger className="secondary-button">Previous</Pagination.PrevTrigger>
      <Pagination.Context>
        {(api) => (
          <span>
            Page {api.page} of {Math.max(api.totalPages, 1)}
          </span>
        )}
      </Pagination.Context>
      <Pagination.NextTrigger className="secondary-button">Next</Pagination.NextTrigger>
    </Pagination.Root>
  );
}
