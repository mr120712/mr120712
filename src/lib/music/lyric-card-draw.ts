// @polsia:user-owned — disegna la scheda «Condividi una parte del testo» su un canvas nel browser e
// ne ricava un PNG. Nessuna rete e nessuna immagine esterna (niente copertine di terzi): solo testo
// e il marchio Solco su sfondo scuro, così il canvas non viene "sporcato" e il file si può salvare e
// condividere. I limiti dell'estratto stanno in lyric-card.ts (parte pura, con i test).
import { brandVisual, siteName } from '@/lib/brand';
import { type LyricCardData, wrapText } from './lyric-card';

const WIDTH = 1080;
const HEIGHT = 1350;
const PADDING = 96;
const SANS = "-apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return { r: 250, g: 250, b: 250 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Disegna la scheda e restituisce un PNG (null se il canvas non è disponibile). L'estratto (già
 * tagliato ai limiti in lyric-card.ts) viene mandato a capo e la dimensione del testo si riduce
 * finché l'estratto entra nello spazio.
 */
export async function renderLyricCard(data: LyricCardData): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bg = brandVisual.og.background || '#000000';
  const fg = brandVisual.og.foreground || '#fafafa';

  // Sfondo scuro con una leggera sfumatura e un filo di accento in alto.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  glow.addColorStop(0, rgba(fg, 0.08));
  glow.addColorStop(0.5, rgba(fg, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Virgoletta d'apertura, grande e tenue.
  ctx.fillStyle = rgba(fg, 0.22);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 220px ${SANS}`;
  ctx.fillText('“', PADDING - 12, 260);

  const textWidth = WIDTH - PADDING * 2;
  const blockTop = 300;
  const blockBottom = HEIGHT - 360;
  const maxBlockHeight = blockBottom - blockTop;

  // Riduce la dimensione del testo finché le righe (mandate a capo) entrano nello spazio. `wrapped`
  // resta sempre misurato a `fontSize`, anche quando si arriva al minimo senza farlo entrare.
  const MIN_FONT = 32;
  const lineRatio = 1.32;
  const wrapAt = (size: number): string[] => {
    ctx.font = `600 ${size}px ${SANS}`;
    return data.lines.flatMap((line) =>
      wrapText(line, textWidth, (text) => ctx.measureText(text).width),
    );
  };
  let fontSize = 62;
  let wrapped = wrapAt(fontSize);
  while (fontSize > MIN_FONT && wrapped.length * fontSize * lineRatio > maxBlockHeight) {
    fontSize -= 2;
    wrapped = wrapAt(fontSize);
  }

  ctx.fillStyle = fg;
  ctx.font = `600 ${fontSize}px ${SANS}`;
  const lineHeight = fontSize * lineRatio;
  const totalHeight = wrapped.length * lineHeight;
  let y = blockTop + Math.max(0, (maxBlockHeight - totalHeight) / 2) + fontSize;
  for (const line of wrapped) {
    ctx.fillText(line, PADDING, y);
    y += lineHeight;
  }

  // Brano e artista.
  const title = data.title.trim() || 'Brano';
  ctx.fillStyle = fg;
  ctx.font = `700 40px ${SANS}`;
  ctx.fillText(ellipsize(ctx, title, textWidth), PADDING, HEIGHT - 288);
  if (data.artist.trim()) {
    ctx.fillStyle = rgba(fg, 0.7);
    ctx.font = `400 34px ${SANS}`;
    ctx.fillText(ellipsize(ctx, data.artist.trim(), textWidth), PADDING, HEIGHT - 240);
  }
  if (data.credit?.trim()) {
    ctx.fillStyle = rgba(fg, 0.5);
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText(ellipsize(ctx, data.credit.trim(), textWidth), PADDING, HEIGHT - 196);
  }

  // Linea di separazione e marchio in basso.
  ctx.strokeStyle = rgba(fg, 0.18);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PADDING, HEIGHT - 150);
  ctx.lineTo(WIDTH - PADDING, HEIGHT - 150);
  ctx.stroke();

  ctx.fillStyle = fg;
  ctx.font = `800 44px ${SANS}`;
  ctx.fillText(siteName.toUpperCase(), PADDING, HEIGHT - 86);
  ctx.fillStyle = rgba(fg, 0.6);
  ctx.font = `400 30px ${SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText('solcomusic.online', WIDTH - PADDING, HEIGHT - 90);

  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** Accorcia con «…» se il testo supera la larghezza (per brano, artista e credito, su una riga). */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}
