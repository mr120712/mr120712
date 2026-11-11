// @polsia:user-owned
import type { SolcoProTheme } from '@/lib/contracts/solco-pro';

export function applySolcoProTheme(theme: SolcoProTheme) {
  if (typeof document === 'undefined') return;
  if (theme === 'default') {
    delete document.documentElement.dataset.solcoProTheme;
  } else {
    document.documentElement.dataset.solcoProTheme = theme;
  }
}
