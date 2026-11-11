// @polsia:user-owned
'use client';

import { CircleCheck, LoaderCircle, Upload } from 'lucide-react';
import { useId, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { FileUploadError, type UploadedFile, uploadFile } from '@/modules/file-upload/client';

// Starter upload field: a click-or-drop zone over a visually hidden native
// input, so the browser's unstyled "Choose file" button never shows. Restyle
// freely; keep the upload going through uploadFile() so the bytes never
// transit through the app.

export interface FileUploadFieldProps {
  /** Visible label. */
  label?: string;
  /** Native `accept` list, e.g. "image/jpeg,image/png,image/webp". Never list HEIC: Polsia refuses it. */
  accept?: string;
  /** Short help shown in the zone, e.g. "JPEG, PNG or WebP". */
  hint?: string;
  /** Called once Polsia has registered the file. Persist `file.key` and `file.url`. */
  onUploaded: (file: UploadedFile) => void;
}

const FALLBACK_ERROR = 'The upload failed. Please try again.';

export function FileUploadField({
  label = 'File',
  accept,
  hint,
  onUploaded,
}: FileUploadFieldProps) {
  const id = useId();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploading = progress !== null;

  async function upload(file: File | undefined) {
    if (!file || uploading) {
      return;
    }

    setError(null);
    setUploaded(null);
    setProgress(0);
    try {
      const result = await uploadFile(file, { onProgress: setProgress });
      setUploaded(result);
      onUploaded(result);
    } catch (cause) {
      setError(cause instanceof FileUploadError ? cause.message : FALLBACK_ERROR);
    } finally {
      setProgress(null);
    }
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    void upload(event.target.files?.[0]);
    // Lets the user pick the same file again after an error.
    event.target.value = '';
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void upload(event.dataTransfer.files[0]);
  }

  const Icon = uploading ? LoaderCircle : uploaded ? CircleCheck : Upload;
  const title = uploading
    ? 'Uploading…'
    : uploaded
      ? uploaded.filename
      : 'Click to choose a file or drag it here';

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={uploading}
        onChange={handleChange}
        aria-invalid={error ? true : undefined}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          // Moving over the zone's own icon or text is not leaving it.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setDragging(false);
        }}
        onDrop={handleDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-muted/30 px-6 py-8 text-center transition-colors hover:bg-muted/60 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
          dragging && 'border-primary bg-muted/60',
          error && 'border-destructive',
        )}
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-background shadow-sm">
          <Icon
            aria-hidden="true"
            className={cn(
              'size-5 text-muted-foreground',
              uploading && 'animate-spin',
              uploaded && 'text-primary',
            )}
          />
        </span>
        <span className="max-w-full truncate text-sm font-medium">{title}</span>
        {hint && !uploading && !uploaded ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
        {uploaded ? <span className="text-xs text-muted-foreground">Click to replace</span> : null}
      </label>
      {uploading ? <Progress value={progress} aria-label="Upload progress" /> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
