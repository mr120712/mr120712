// @polsia:user-owned

import type { CheckIssue, ProductCheckResult } from '@/lib/contracts/workspace';

export interface CorrectionRow {
  id: string;
  productName: string;
  productUrl: string;
  field: string;
  expected: string;
  observed: string | null;
  reason: string;
  action: string;
  checkedAt: string;
}

const fieldLabels: Record<CheckIssue['field'], string> = {
  page: 'Pagina',
  link: 'Link',
  redirect: 'Redirect',
  price: 'Prezzo',
  availability: 'Disponibilità',
};

export function correctionRows(input: {
  productId: string;
  productName: string;
  productUrl: string;
  checkedAt: string;
  result: ProductCheckResult;
}): CorrectionRow[] {
  return input.result.issues.map((issue: CheckIssue) => ({
    id: `${input.productId}:${issue.id}`,
    productName: input.productName,
    productUrl: input.productUrl,
    field: fieldLabels[issue.field],
    expected: issue.expected,
    observed: issue.observed,
    reason: issue.reason,
    action: issue.action,
    checkedAt: input.checkedAt,
  }));
}
