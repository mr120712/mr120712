// @polsia:framework-owned

import { z } from 'zod';

export const CSV_EXPORT_LIMITS = {
  records: 10_000,
  bytes: 10_485_760,
  columns: 50,
  cellCharacters: 16_384,
  requestBytes: 65_536,
  readMilliseconds: 30_000,
} as const;

export const CSV_EXPORT_FORMAT = 'polsia-csv-v2';
export const RESERVED_COLUMNS = [
  '__polsia_format',
  '__polsia_source',
  '__polsia_schema',
  '__polsia_scope',
  '__polsia_key',
  '__polsia_version',
] as const;

export type CsvDelimiter = ',' | ';';
export type CsvValueKind = 'text' | 'identifier' | 'number' | 'boolean' | 'date' | 'datetime';
export interface CsvColumnDescription {
  key: string;
  label: string;
  kind: CsvValueKind;
  access: 'editable' | 'readonly';
  nullable: boolean;
}
export interface CsvExportInput {
  sourceId: string;
  filters: unknown;
  columns?: string[];
  delimiter?: CsvDelimiter;
}
export interface CsvSourceDescription {
  id: string;
  label: string;
  schemaVersion: string;
  columns: CsvColumnDescription[];
  limits: typeof CSV_EXPORT_LIMITS;
  format: typeof CSV_EXPORT_FORMAT;
}

export const CSV_EXPORT_ERRORS = {
  UNAUTHENTICATED: { status: 401, message: 'Sign in to export data.' },
  FORBIDDEN: { status: 403, message: 'You cannot export this source or these fields.' },
  INVALID_REQUEST: { status: 400, message: 'The export request is invalid.' },
  INVALID_FILTERS: { status: 400, message: 'The export filters are invalid.' },
  SOURCE_NOT_FOUND: { status: 404, message: 'Unknown export source.' },
  NO_RESULTS: { status: 422, message: 'No results to export with these filters.' },
  ROW_LIMIT: { status: 413, message: 'The export exceeds 10,000 rows. Narrow the filters.' },
  BYTE_LIMIT: { status: 413, message: 'The export exceeds 10 MiB. Narrow the filters.' },
  CELL_LIMIT: { status: 413, message: 'A cell exceeds 16,384 characters. Export cancelled.' },
  BODY_LIMIT: { status: 413, message: 'The request exceeds 64 KiB.' },
  READ_FAILED: { status: 500, message: 'Reading the data failed. No file was created.' },
  INVALID_SOURCE: { status: 500, message: 'The source does not meet the export contract.' },
  TIMEOUT: { status: 504, message: 'The export took too long. Narrow the filters.' },
  CANCELLED: { status: 408, message: 'The export was interrupted.' },
} as const;
export type CsvExportErrorCode = keyof typeof CSV_EXPORT_ERRORS;

export class CsvExportError extends Error {
  readonly code: CsvExportErrorCode;
  constructor(code: CsvExportErrorCode) {
    super(CSV_EXPORT_ERRORS[code].message);
    this.name = 'CsvExportError';
    this.code = code;
  }
}

export const exportResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        csv: z
          .string()
          .refine((csv) => new TextEncoder().encode(csv).byteLength <= CSV_EXPORT_LIMITS.bytes),
        records: z.number().int().min(1).max(CSV_EXPORT_LIMITS.records),
        filename: z.string().regex(/^[a-z][a-z0-9_-]{0,63}\.csv$/),
      })
      .strict(),
  })
  .strict();
export const exportErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();
