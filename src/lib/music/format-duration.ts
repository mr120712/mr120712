// @polsia:user-owned — formattazione durata: m:ss (h:mm:ss oltre l'ora). Pura e testabile.
export function formatClock(totalSeconds: number | null | undefined): string {
  const seconds =
    typeof totalSeconds === 'number' && Number.isFinite(totalSeconds)
      ? Math.max(0, Math.floor(totalSeconds))
      : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
