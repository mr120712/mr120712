// @polsia:user-owned
import type { ReactNode } from 'react';

/** Place inside the caller's form; field labels, errors and submit behavior stay explicit. */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="app-ui-form-section" aria-label={title}>
      <div>
        <h2>{title}</h2>
        {description && <div className="app-ui-description">{description}</div>}
      </div>
      <div className="app-ui-form-fields">{children}</div>
    </section>
  );
}

export function FormActions({ children, feedback }: { children: ReactNode; feedback?: ReactNode }) {
  return (
    <div className="app-ui-form-actions">
      <div>{feedback}</div>
      <div className="app-ui-actions">{children}</div>
    </div>
  );
}
