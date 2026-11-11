import { describe, expect, it } from 'vitest';
import { themeProps } from '@/components/theme-provider';

describe('themeProps (src/lib/color-theme.ts seam)', () => {
  it('follows the OS for system, exactly the pre-seam props', () => {
    expect(themeProps('system')).toEqual({ defaultTheme: 'system', enableSystem: true });
  });

  it.each(['light', 'dark'] as const)('forces %s and ignores the OS', (colorTheme) => {
    expect(themeProps(colorTheme)).toEqual({
      defaultTheme: colorTheme,
      forcedTheme: colorTheme,
      enableSystem: false,
    });
  });
});
