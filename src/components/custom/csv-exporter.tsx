// @polsia:user-owned
'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CsvDelimiter } from '@/modules/csv-export/contracts';
import {
  csvExportErrorMessage,
  requestCsvExport,
  saveCsvFile,
} from '@/modules/csv-export/download';

export interface CsvExporterProps {
  sourceId: string;
  filters: unknown;
  columns?: string[];
  delimiter?: CsvDelimiter;
  label?: string;
}

export function CsvExporter({
  sourceId,
  filters,
  columns,
  delimiter = ',',
  label = 'Scarica il CSV delle correzioni',
}: CsvExporterProps) {
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const active = useRef<AbortController | null>(null);
  const requestKey = JSON.stringify({ sourceId, filters, columns, delimiter });

  useEffect(() => {
    // Changing active filters/source invalidates an outstanding export.
    if (requestKey) {
      setStatus('idle');
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [requestKey]);

  async function download() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setStatus('loading');
    try {
      const result = await requestCsvExport(
        { sourceId, filters, columns, delimiter },
        controller.signal,
      );
      if (controller.signal.aborted || active.current !== controller) return;
      saveCsvFile(result.data.csv, result.data.filename);
      toast.success(`CSV pronto: ${result.data.records.toLocaleString('it-IT')} righe esportate.`);
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      toast.error(csvExportErrorMessage(error));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setStatus('idle');
      }
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        disabled={status === 'loading'}
        onClick={download}
        aria-busy={status === 'loading'}
      >
        {status === 'loading' ? 'Preparazione CSV…' : label}
      </Button>
    </div>
  );
}
