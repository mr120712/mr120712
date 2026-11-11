// @polsia:user-owned
import type { Key, ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type DataColumn<Row> = {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: 'left' | 'right';
};

/** Rendering only. Put sorting, filtering, pagination and fetching in the calling feature. */
export function DataTable<Row>({
  label,
  rows,
  columns,
  rowKey,
  loading = false,
  loadingLabel = 'Loading…',
  error,
  empty = 'No results.',
}: {
  label: string;
  rows: readonly Row[];
  columns: readonly DataColumn<Row>[];
  rowKey: (row: Row) => Key;
  loading?: boolean;
  loadingLabel?: string;
  error?: ReactNode;
  empty?: ReactNode;
}) {
  const state = error ? (
    <div role="alert">{error}</div>
  ) : loading ? (
    <output aria-live="polite">{loadingLabel}</output>
  ) : rows.length === 0 ? (
    empty
  ) : null;
  return (
    <div className="app-ui-table">
      <Table aria-label={label} aria-busy={loading}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.id}
                scope="col"
                className={cn(
                  'p-[var(--app-row-padding)]',
                  column.align === 'right' && 'app-ui-align-right text-right',
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {state !== null ? (
            <TableRow>
              <TableCell
                colSpan={Math.max(1, columns.length)}
                className="p-[var(--app-row-padding)]"
              >
                <div className="app-ui-table-state">{state}</div>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      'p-[var(--app-row-padding)]',
                      column.align === 'right' && 'app-ui-align-right text-right',
                    )}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
