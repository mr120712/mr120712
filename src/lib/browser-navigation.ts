// @polsia:user-owned — navigazione completa del browser (ricarica la pagina, così una sessione
// appena creata viene letta da tutta l'app). Isolata qui per poterla sostituire nei test.
'use client';

export function navigateTo(url: string): void {
  window.location.assign(url);
}
