// @polsia:user-owned
import type { SolcoProCard } from '@/lib/contracts/solco-pro';

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[character] ?? character;
  });
}

function wrapSvgText(value: string, maxLength: number, maxLines: number, lineHeight: number) {
  let remaining = value.trim();
  const lines: string[] = [];
  while (remaining && lines.length < maxLines) {
    if (remaining.length <= maxLength) {
      lines.push(remaining);
      remaining = '';
      break;
    }
    let splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < 1) splitAt = maxLength;
    lines.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining && lines.length) {
    const lastIndex = lines.length - 1;
    const lastLine = lines[lastIndex] ?? '';
    lines[lastIndex] = `${lastLine.slice(0, maxLength - 1)}…`;
  }
  return lines
    .map((item, index) => `<tspan x="96" dy="${index ? lineHeight : 0}">${escapeXml(item)}</tspan>`)
    .join('');
}

export function buildSolcoListeningCardSvg(card: SolcoProCard) {
  const { albumName, artistName, listenedOn, rating, note } = card.listening;
  const albumLines = wrapSvgText(albumName, 24, 2, 72);
  const artistLines = wrapSvgText(artistName, 36, 1, 44);
  const safeDate = escapeXml(listenedOn);
  const noteLines = wrapSvgText(note, 52, 4, 48);
  const stars = `${'★'.repeat(Math.floor(rating))}${rating % 1 ? '½' : ''}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(albumName)} — ${escapeXml(artistName)}</title>
  <desc id="description">Card del diario d’ascolto del ${safeDate}</desc>
  <rect width="1200" height="1200" fill="#10232f" rx="44"/>
  <circle cx="1010" cy="160" r="260" fill="#c5ed72" opacity=".13"/>
  <path d="M96 160h1008" stroke="#83d9d1" stroke-opacity=".34"/>
  <text x="96" y="128" fill="#c5ed72" font-family="Arial,sans-serif" font-size="28" font-weight="700" letter-spacing="5">UN ASCOLTO DA RICORDARE</text>
  <text x="96" y="430" fill="#edf5f6" font-family="Arial,sans-serif" font-size="70" font-weight="700">${albumLines}</text>
  <text x="96" y="590" fill="#b1c5cd" font-family="Arial,sans-serif" font-size="40">${artistLines}</text>
  <text x="96" y="710" fill="#c5ed72" font-family="Arial,sans-serif" font-size="54">${stars}</text>
  <text x="96" y="810" fill="#edf5f6" font-family="Arial,sans-serif" font-size="30" font-style="italic">${noteLines}</text>
  <text x="96" y="1080" fill="#b1c5cd" font-family="Arial,sans-serif" font-size="28">${safeDate}</text>
</svg>`;
}
