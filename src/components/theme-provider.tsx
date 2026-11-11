// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// next-themes wrapper. Wired into layout.tsx providers slot (class-based dark mode).
'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type * as React from 'react';
import type { ColorTheme } from '@/lib/color-theme';

type NextThemesProps = React.ComponentProps<typeof NextThemesProvider>;

/** next-themes value that follows the visitor's OS `prefers-color-scheme`. */
export const SYSTEM_THEME = 'system';

/** next-themes props for the app's `colorTheme` seam (`src/lib/color-theme.ts`). */
export function themeProps(
  colorTheme: ColorTheme,
): Pick<NextThemesProps, 'defaultTheme' | 'enableSystem' | 'forcedTheme'> {
  if (colorTheme === SYSTEM_THEME) {
    return { defaultTheme: SYSTEM_THEME, enableSystem: true };
  }

  // defaultTheme too: useTheme().theme (the Toaster reads it) ignores forcedTheme.
  return { defaultTheme: colorTheme, forcedTheme: colorTheme, enableSystem: false };
}

/** Computes the theme props here, client side: a server layout cannot call a client module's function. */
export function ThemeProvider({
  children,
  colorTheme = SYSTEM_THEME,
  ...props
}: NextThemesProps & { colorTheme?: ColorTheme }) {
  return (
    <NextThemesProvider {...props} {...themeProps(colorTheme)}>
      {children}
    </NextThemesProvider>
  );
}
