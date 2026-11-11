// @polsia:user-owned: the app's color scheme, read by the framework-owned layout.
//
// Pick the value that matches what was designed in `src/app/brand-theme.css`:
//
//   'light':  one light look; the visitor's OS dark mode is ignored, no `.dark` block needed.
//   'dark':   one dark look; write the dark palette in `:root`, the OS is ignored.
//   'system': both looks are designed (`:root` AND `.dark`); follow the OS, show a toggle.
//
// The layout forces the chosen theme on <html> (next-themes `forcedTheme`); SiteNav shows
// its ThemeToggle only in 'system'.

export type ColorTheme = 'light' | 'dark' | 'system';

export const colorTheme: ColorTheme = 'dark';
