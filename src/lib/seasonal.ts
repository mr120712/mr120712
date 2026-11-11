// @polsia:user-owned — tema stagionale di Solco. Imposta `null` per tornare al tema bianco e nero.
export type SeasonalTheme = 'christmas' | null;

export const seasonalTheme: SeasonalTheme = 'christmas';

/** Classe sull'elemento <html> che attiva i colori stagionali in brand-theme.css. */
export const seasonalHtmlClass = seasonalTheme ? `theme-${seasonalTheme}` : '';
