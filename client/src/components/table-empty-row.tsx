import { TableCell, TableRow } from "@/components/ui/table";

interface TableEmptyRowProps {
  colSpan: number;
  message: string;
}

/** Full-width row shown when a table has no items. */
export function TableEmptyRow({ colSpan, message }: TableEmptyRowProps) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  );
}
