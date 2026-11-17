// @polsia:user-owned — copertine disegnate delle playlist divertenti: un disegno SVG per ciascuna
// (il comodino di «Piede comodino», la tazza di «Lunedì mattina»…), stile piatto e colori propri.
// Inline, senza script né gradienti con id (CSP-safe, nessun doppione di id in pagina): si usa sia
// nelle pagine server (Home, /generi) sia nei componenti client (pagina della playlist, Libreria).
// Decorativa quando il nome della playlist sta accanto; con `decorative={false}` descrive il
// disegno (PLAYLIST_COVER_LABELS).

import type { ReactNode } from 'react';
import { PLAYLIST_COVER_LABELS, type PlaylistCoverId } from '@/lib/music/playlist-covers';

/** Stella a quattro punte (le scintille del dolore sul comodino). */
function Spark({ x, y, size, fill }: { x: number; y: number; size: number; fill: string }) {
  const s = size;
  const i = size * 0.28;
  return (
    <polygon
      points={`${x},${y - s} ${x + i},${y - i} ${x + s},${y} ${x + i},${y + i} ${x},${y + s} ${x - i},${y + i} ${x - s},${y} ${x - i},${y - i}`}
      fill={fill}
    />
  );
}

/** Nota musicale (gambo a destra, testa ovale). */
function Note({ x, y, fill }: { x: number; y: number; fill: string }) {
  return (
    <g fill={fill}>
      <ellipse cx={x} cy={y} rx="7" ry="5" transform={`rotate(-20 ${x} ${y})`} />
      <rect x={x + 4} y={y - 26} width="3" height="27" rx="1.5" />
      <path d={`M${x + 7},${y - 26} q10,2 12,10 q-4,-5 -12,-4 z`} />
    </g>
  );
}

const Comodino = (
  <>
    <rect width="200" height="200" fill="#1f2a44" />
    <circle cx="108" cy="46" r="46" fill="#f6c667" fillOpacity="0.14" />
    <ellipse cx="112" cy="174" rx="60" ry="8" fill="#0f1628" fillOpacity="0.7" />
    {/* comodino */}
    <rect x="74" y="160" width="10" height="12" rx="2" fill="#8c5a33" />
    <rect x="140" y="160" width="10" height="12" rx="2" fill="#8c5a33" />
    <rect x="70" y="94" width="84" height="70" rx="6" fill="#b97a4a" />
    <rect x="64" y="86" width="96" height="12" rx="4" fill="#d59a63" />
    <rect x="80" y="106" width="64" height="20" rx="3" fill="#a2663b" />
    <circle cx="112" cy="116" r="3.5" fill="#f3e2c7" />
    <rect x="80" y="134" width="64" height="20" rx="3" fill="#a2663b" />
    <circle cx="112" cy="144" r="3.5" fill="#f3e2c7" />
    {/* lampada */}
    <rect x="104" y="76" width="16" height="10" rx="2" fill="#e7d8c3" />
    <rect x="110" y="54" width="4" height="24" fill="#e7d8c3" />
    <polygon points="90,30 134,30 144,58 80,58" fill="#f6c667" />
    <rect x="80" y="56" width="64" height="4" rx="2" fill="#e0ad4f" />
    {/* piede che arriva sullo spigolo */}
    <rect x="0" y="118" width="30" height="40" rx="6" fill="#f1c7a8" />
    <ellipse cx="38" cy="158" rx="30" ry="13" fill="#f1c7a8" />
    <circle cx="63" cy="146" r="5.5" fill="#f1c7a8" />
    <circle cx="66" cy="155" r="4.5" fill="#f1c7a8" />
    <circle cx="66" cy="163" r="4" fill="#f1c7a8" />
    <circle cx="63" cy="170" r="3.5" fill="#f1c7a8" />
    <Spark x={72} y={140} size={9} fill="#ffd166" />
    <Spark x={60} y={184} size={6} fill="#ffd166" />
    <Spark x={84} y={178} size={5} fill="#ff7b54" />
  </>
);

const Caffe = (
  <>
    <rect width="200" height="200" fill="#fde8d7" />
    <circle cx="152" cy="52" r="28" fill="#f7b267" />
    <rect x="0" y="150" width="200" height="50" fill="#f3d2bb" />
    {/* vapore */}
    <g fill="none" stroke="#9a7b67" strokeWidth="4" strokeLinecap="round" opacity="0.75">
      <path d="M82,80 c-7,-9 7,-15 0,-24" />
      <path d="M100,78 c-8,-10 8,-17 0,-28" />
      <path d="M118,80 c-7,-9 7,-15 0,-24" />
    </g>
    {/* piattino e tazza */}
    <ellipse cx="100" cy="152" rx="60" ry="12" fill="#ffffff" stroke="#d9c3b0" strokeWidth="3" />
    <path
      d="M138,108 q28,0 28,17 q0,17 -28,17"
      fill="none"
      stroke="#d9c3b0"
      strokeWidth="9"
      strokeLinecap="round"
    />
    <path d="M138,108 q28,0 28,17 q0,17 -28,17" fill="none" stroke="#ffffff" strokeWidth="4" />
    <path d="M60,98 h80 v30 a40,22 0 0 1 -80 0 z" fill="#ffffff" stroke="#d9c3b0" strokeWidth="3" />
    <ellipse cx="100" cy="99" rx="38" ry="8" fill="#6b3e26" />
    <ellipse cx="92" cy="97" rx="10" ry="3" fill="#8d5b3f" />
  </>
);

const Doccia = (
  <>
    <rect width="200" height="200" fill="#d6ecf7" />
    <circle cx="44" cy="150" r="40" fill="#ffffff" fillOpacity="0.45" />
    {/* braccio e soffione */}
    <path
      d="M56,28 h48 q12,0 12,12 v14"
      fill="none"
      stroke="#8aa5b8"
      strokeWidth="9"
      strokeLinecap="round"
    />
    <polygon points="78,54 154,54 164,74 68,74" fill="#b8cad6" />
    <rect x="66" y="72" width="100" height="9" rx="4" fill="#93a9b8" />
    {/* acqua */}
    <g stroke="#4fa3d8" strokeWidth="3.5" strokeLinecap="round" opacity="0.85">
      <line x1="78" y1="90" x2="78" y2="150" />
      <line x1="94" y1="90" x2="94" y2="168" />
      <line x1="110" y1="90" x2="110" y2="140" />
      <line x1="126" y1="90" x2="126" y2="172" />
      <line x1="142" y1="90" x2="142" y2="150" />
      <line x1="158" y1="90" x2="158" y2="130" />
    </g>
    <g fill="#4fa3d8">
      <circle cx="86" cy="178" r="3" />
      <circle cx="118" cy="162" r="3" />
      <circle cx="150" cy="170" r="3" />
    </g>
    <Note x={36} y={92} fill="#e76f8a" />
    <Note x={176} y={158} fill="#e76f8a" />
  </>
);

const Traffico = (
  <>
    <rect width="200" height="200" fill="#27233a" />
    <polygon points="0,200 200,200 128,96 72,96" fill="#3b3750" />
    <line
      x1="100"
      y1="200"
      x2="100"
      y2="108"
      stroke="#e8d58a"
      strokeWidth="3"
      strokeDasharray="10 10"
    />
    {/* auto davanti, lontana */}
    <rect x="86" y="58" width="28" height="18" rx="4" fill="#565270" />
    <rect x="88" y="68" width="6" height="4" rx="1" fill="#ff4d4d" />
    <rect x="106" y="68" width="6" height="4" rx="1" fill="#ff4d4d" />
    {/* la nostra auto, vista da dietro */}
    <circle cx="70" cy="124" r="20" fill="#ff4d4d" fillOpacity="0.3" />
    <circle cx="130" cy="124" r="20" fill="#ff4d4d" fillOpacity="0.3" />
    <rect x="68" y="80" width="64" height="28" rx="8" fill="#1e2b48" />
    <rect x="74" y="85" width="52" height="16" rx="4" fill="#86b4ff" fillOpacity="0.45" />
    <rect x="56" y="98" width="88" height="50" rx="10" fill="#3f7ad8" />
    <rect x="60" y="118" width="20" height="10" rx="3" fill="#ff4d4d" />
    <rect x="120" y="118" width="20" height="10" rx="3" fill="#ff4d4d" />
    <rect x="88" y="122" width="24" height="10" rx="2" fill="#f3f3f3" />
    <rect x="58" y="136" width="84" height="6" fill="#2d5aa6" />
    <rect x="62" y="144" width="16" height="10" rx="3" fill="#141420" />
    <rect x="122" y="144" width="16" height="10" rx="3" fill="#141420" />
  </>
);

const Scopa = (
  <>
    <rect width="200" height="200" fill="#e9f5e1" />
    <rect x="0" y="160" width="200" height="40" fill="#cfe3c2" />
    {/* scopa */}
    <line
      x1="124"
      y1="22"
      x2="84"
      y2="122"
      stroke="#c08a4e"
      strokeWidth="8"
      strokeLinecap="round"
    />
    <polygon points="60,118 108,118 128,170 44,170" fill="#e8c15a" />
    <polygon points="64,128 106,128 110,140 62,140" fill="#c0392b" />
    <g stroke="#c9a03d" strokeWidth="2">
      <line x1="60" y1="142" x2="54" y2="168" />
      <line x1="72" y1="142" x2="70" y2="168" />
      <line x1="84" y1="142" x2="86" y2="168" />
      <line x1="96" y1="142" x2="102" y2="168" />
      <line x1="106" y1="142" x2="118" y2="168" />
    </g>
    {/* secchio */}
    <polygon points="132,124 182,124 176,172 138,172" fill="#4f9ad6" />
    <rect x="128" y="116" width="58" height="10" rx="3" fill="#3b7fb5" />
    <path d="M136,118 q21,-30 42,0" fill="none" stroke="#3b7fb5" strokeWidth="4" />
    <g fill="#ffffff" fillOpacity="0.9" stroke="#bfe0f7" strokeWidth="1.5">
      <circle cx="152" cy="98" r="9" />
      <circle cx="170" cy="82" r="6" />
      <circle cx="140" cy="84" r="4.5" />
      <circle cx="178" cy="104" r="3.5" />
    </g>
  </>
);

const Cuscino = (
  <>
    <rect width="200" height="200" fill="#e8e4f7" />
    <circle cx="46" cy="46" r="18" fill="#f8e9a1" />
    <circle cx="56" cy="40" r="15" fill="#e8e4f7" />
    <ellipse cx="100" cy="158" rx="70" ry="8" fill="#cfc6ea" fillOpacity="0.8" />
    <path
      d="M40,92 q60,-16 120,0 q8,34 0,62 q-60,14 -120,0 q-8,-28 0,-62 z"
      fill="#ffffff"
      stroke="#cfc6ea"
      strokeWidth="3"
      strokeLinejoin="round"
    />
    <path d="M58,104 q42,-8 84,0" fill="none" stroke="#e4def5" strokeWidth="3" />
    <path d="M58,142 q42,8 84,0" fill="none" stroke="#e4def5" strokeWidth="3" />
    <g fill="none" stroke="#8b7ad8" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round">
      <polyline points="112,72 126,72 112,86 126,86" />
      <polyline points="134,54 152,54 134,72 152,72" />
      <polyline points="158,30 180,30 158,52 180,52" />
    </g>
  </>
);

const Pizza = (
  <>
    <rect width="200" height="200" fill="#fff1d6" />
    <circle cx="100" cy="112" r="78" fill="#ffe3b0" fillOpacity="0.6" />
    <polygon points="100,178 38,56 162,56" fill="#f6c66b" />
    <path
      d="M38,56 q62,-26 124,0"
      fill="none"
      stroke="#d98a3c"
      strokeWidth="16"
      strokeLinecap="round"
    />
    <g fill="#c0392b">
      <circle cx="80" cy="84" r="11" />
      <circle cx="120" cy="90" r="10" />
      <circle cx="100" cy="124" r="10" />
    </g>
    <g fill="#8e2a1f">
      <circle cx="76" cy="82" r="2" />
      <circle cx="84" cy="88" r="2" />
      <circle cx="118" cy="86" r="2" />
      <circle cx="124" cy="94" r="2" />
      <circle cx="98" cy="122" r="2" />
      <circle cx="104" cy="128" r="2" />
    </g>
    <ellipse cx="96" cy="100" rx="10" ry="5.5" fill="#4caf50" transform="rotate(-30 96 100)" />
    <ellipse cx="112" cy="112" rx="9" ry="5" fill="#43a047" transform="rotate(25 112 112)" />
    <ellipse cx="100" cy="150" rx="7" ry="4" fill="#4caf50" transform="rotate(-10 100 150)" />
  </>
);

const Zanzara = (
  <>
    <rect width="200" height="200" fill="#1b2033" />
    <circle cx="152" cy="50" r="24" fill="#f2e6b1" />
    <path
      d="M24,176 q20,-60 60,-66"
      fill="none"
      stroke="#9aa3c7"
      strokeWidth="2.5"
      strokeDasharray="4 7"
      strokeLinecap="round"
    />
    {/* ali */}
    <ellipse
      cx="94"
      cy="88"
      rx="26"
      ry="9"
      fill="#c7d6ff"
      fillOpacity="0.55"
      transform="rotate(-35 94 88)"
    />
    <ellipse
      cx="82"
      cy="98"
      rx="24"
      ry="8"
      fill="#c7d6ff"
      fillOpacity="0.45"
      transform="rotate(-15 82 98)"
    />
    {/* corpo, testa e pungiglione */}
    <ellipse cx="98" cy="112" rx="28" ry="10" fill="#4a4a5a" transform="rotate(-20 98 112)" />
    <circle cx="126" cy="100" r="8" fill="#4a4a5a" />
    <circle cx="129" cy="98" r="2" fill="#ffffff" />
    <line
      x1="132"
      y1="102"
      x2="164"
      y2="114"
      stroke="#4a4a5a"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
    <g fill="none" stroke="#4a4a5a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="86,120 74,134 66,146" />
      <polyline points="100,122 96,138 86,148" />
      <polyline points="112,118 118,136 112,148" />
      <polyline points="118,104 130,120 142,124" />
    </g>
  </>
);

const Manubrio = (
  <>
    <rect width="200" height="200" fill="#e3f0ff" />
    <ellipse cx="100" cy="166" rx="84" ry="8" fill="#c8d9ee" />
    {/* calendario: primo del mese */}
    <rect
      x="22"
      y="22"
      width="58"
      height="54"
      rx="6"
      fill="#ffffff"
      stroke="#c9ced6"
      strokeWidth="2"
    />
    <path d="M22,36 h58 v-8 q0,-6 -6,-6 h-46 q-6,0 -6,6 z" fill="#e74c3c" />
    <rect x="34" y="14" width="5" height="12" rx="2.5" fill="#8a8f99" />
    <rect x="63" y="14" width="5" height="12" rx="2.5" fill="#8a8f99" />
    <line x1="52" y1="46" x2="52" y2="68" stroke="#2f343d" strokeWidth="5" strokeLinecap="round" />
    <line x1="45" y1="52" x2="52" y2="46" stroke="#2f343d" strokeWidth="5" strokeLinecap="round" />
    {/* manubrio */}
    <rect x="52" y="104" width="96" height="12" rx="6" fill="#8a8f99" />
    <rect x="48" y="96" width="12" height="28" rx="3" fill="#5a606b" />
    <rect x="140" y="96" width="12" height="28" rx="3" fill="#5a606b" />
    <rect x="28" y="82" width="22" height="56" rx="5" fill="#2f343d" />
    <rect x="150" y="82" width="22" height="56" rx="5" fill="#2f343d" />
    <rect x="14" y="90" width="14" height="40" rx="4" fill="#3a4049" />
    <rect x="172" y="90" width="14" height="40" rx="4" fill="#3a4049" />
    <g fill="#4fa3d8">
      <path d="M160,46 q8,12 0,16 q-8,-4 0,-16 z" />
      <path d="M176,60 q6,9 0,12 q-6,-3 0,-12 z" />
    </g>
  </>
);

const Lampadina = (
  <>
    <rect width="200" height="200" fill="#2b2b36" />
    <circle cx="92" cy="86" r="42" fill="#e9ecf2" stroke="#c3c8d3" strokeWidth="3" />
    <circle cx="78" cy="80" r="4" fill="#4a5160" />
    <circle cx="104" cy="80" r="4" fill="#4a5160" />
    <path
      d="M78,104 q14,-12 28,0"
      fill="none"
      stroke="#4a5160"
      strokeWidth="3.5"
      strokeLinecap="round"
    />
    <path d="M74,122 h36 v10 h-36 z" fill="#b8bfcc" />
    <rect x="76" y="134" width="32" height="6" rx="2" fill="#9aa3b2" />
    <rect x="76" y="143" width="32" height="6" rx="2" fill="#9aa3b2" />
    <rect x="82" y="152" width="20" height="7" rx="3" fill="#7f8896" />
    {/* bolletta */}
    <g transform="rotate(8 150 146)">
      <rect
        x="124"
        y="112"
        width="52"
        height="68"
        rx="4"
        fill="#ffffff"
        stroke="#d4d4dc"
        strokeWidth="2"
      />
      <line
        x1="132"
        y1="124"
        x2="168"
        y2="124"
        stroke="#c3c8d3"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="132"
        y1="134"
        x2="160"
        y2="134"
        stroke="#c3c8d3"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="132"
        y1="144"
        x2="164"
        y2="144"
        stroke="#c3c8d3"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <text
        x="150"
        y="172"
        textAnchor="middle"
        fontSize="22"
        fontWeight="800"
        fontFamily="system-ui, sans-serif"
        fill="#e74c3c"
      >
        €
      </text>
    </g>
  </>
);

const Biglietto = (
  <>
    <rect width="200" height="200" fill="#e7f0e4" />
    {/* tabellone */}
    <rect x="46" y="26" width="108" height="46" rx="6" fill="#1f2330" />
    <rect x="52" y="32" width="96" height="34" rx="3" fill="#2b3040" />
    <text
      x="100"
      y="60"
      textAnchor="middle"
      fontSize="30"
      fontWeight="800"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      fill="#ff5a5a"
    >
      17
    </text>
    {/* biglietto */}
    <g transform="rotate(-8 100 134)">
      <rect
        x="54"
        y="102"
        width="92"
        height="64"
        rx="6"
        fill="#ffffff"
        stroke="#cbd5c7"
        strokeWidth="2"
      />
      <line
        x1="54"
        y1="118"
        x2="146"
        y2="118"
        stroke="#cbd5c7"
        strokeWidth="2"
        strokeDasharray="4 4"
      />
      <text
        x="100"
        y="152"
        textAnchor="middle"
        fontSize="26"
        fontWeight="800"
        fontFamily="system-ui, sans-serif"
        fill="#2f3b2a"
      >
        A 342
      </text>
    </g>
    <ellipse cx="100" cy="180" rx="56" ry="6" fill="#cfdccb" />
  </>
);

const Pentola = (
  <>
    <rect width="200" height="200" fill="#fde9d9" />
    <g fill="none" stroke="#b7a89e" strokeWidth="4" strokeLinecap="round" opacity="0.7">
      <path d="M78,74 c-7,-9 7,-15 0,-26" />
      <path d="M100,70 c-8,-10 8,-17 0,-30" />
      <path d="M122,74 c-7,-9 7,-15 0,-26" />
    </g>
    {/* cucchiaio di legno */}
    <line
      x1="150"
      y1="62"
      x2="132"
      y2="100"
      stroke="#c08a4e"
      strokeWidth="6"
      strokeLinecap="round"
    />
    <ellipse cx="154" cy="54" rx="8" ry="11" fill="#c08a4e" transform="rotate(25 154 54)" />
    {/* pentola */}
    <rect x="30" y="108" width="22" height="10" rx="5" fill="#4a3b35" />
    <rect x="148" y="108" width="22" height="10" rx="5" fill="#4a3b35" />
    <rect x="50" y="100" width="100" height="60" rx="10" fill="#d14b3c" />
    <rect x="50" y="100" width="100" height="12" fill="#b23a2d" />
    <ellipse cx="100" cy="98" rx="54" ry="9" fill="#5c4b45" />
    <circle cx="100" cy="88" r="6" fill="#2f2724" />
    {/* fuoco */}
    <g>
      <ellipse cx="80" cy="174" rx="7" ry="12" fill="#f39c12" />
      <ellipse cx="100" cy="172" rx="8" ry="14" fill="#f39c12" />
      <ellipse cx="120" cy="174" rx="7" ry="12" fill="#f39c12" />
      <ellipse cx="80" cy="178" rx="3.5" ry="6" fill="#f9d35b" />
      <ellipse cx="100" cy="177" rx="4" ry="7" fill="#f9d35b" />
      <ellipse cx="120" cy="178" rx="3.5" ry="6" fill="#f9d35b" />
    </g>
  </>
);

const Portatile = (
  <>
    <rect width="200" height="200" fill="#e6ecf5" />
    <rect x="40" y="44" width="120" height="82" rx="6" fill="#2b2f3a" />
    <rect x="46" y="50" width="108" height="70" rx="3" fill="#3e4a63" />
    {/* la griglia della videochiamata */}
    <g fill="#566a8f">
      <rect x="50" y="54" width="50" height="31" rx="2" />
      <rect x="104" y="54" width="46" height="31" rx="2" />
      <rect x="50" y="89" width="50" height="27" rx="2" />
      <rect x="104" y="89" width="46" height="27" rx="2" />
    </g>
    <g fill="#c9d1dd">
      <circle cx="75" cy="66" r="6" />
      <path d="M63,85 q12,-12 24,0 z" />
      <circle cx="127" cy="66" r="6" />
      <path d="M115,85 q12,-12 24,0 z" />
      <circle cx="75" cy="100" r="5" />
      <path d="M65,116 q10,-10 20,0 z" />
    </g>
    {/* tu: camera spenta */}
    <line
      x1="112"
      y1="94"
      x2="142"
      y2="112"
      stroke="#e74c3c"
      strokeWidth="3"
      strokeLinecap="round"
    />
    <rect x="118" y="96" width="14" height="10" rx="2" fill="#c9d1dd" />
    <polygon points="132,99 138,96 138,106 132,103" fill="#c9d1dd" />
    {/* base e microfono muto */}
    <polygon points="28,130 172,130 184,150 16,150" fill="#c9d1dd" />
    <rect x="80" y="134" width="40" height="4" rx="2" fill="#aab4c4" />
    <g transform="translate(100 164)">
      <rect x="-5" y="-14" width="10" height="18" rx="5" fill="#4a5160" />
      <path
        d="M-10,0 q10,10 20,0"
        fill="none"
        stroke="#4a5160"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line x1="0" y1="10" x2="0" y2="16" stroke="#4a5160" strokeWidth="3" strokeLinecap="round" />
      <line
        x1="-12"
        y1="-14"
        x2="12"
        y2="14"
        stroke="#e74c3c"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </g>
  </>
);

const Libri = (
  <>
    <rect width="200" height="200" fill="#f3ead8" />
    <rect x="0" y="156" width="200" height="44" fill="#e2d4b8" />
    {/* sveglia: le due di notte */}
    <circle cx="42" cy="50" r="20" fill="#ffffff" stroke="#7a6a55" strokeWidth="3" />
    <line x1="42" y1="50" x2="42" y2="38" stroke="#7a6a55" strokeWidth="3" strokeLinecap="round" />
    <line x1="42" y1="50" x2="51" y2="45" stroke="#7a6a55" strokeWidth="3" strokeLinecap="round" />
    <circle cx="28" cy="33" r="4" fill="#7a6a55" />
    <circle cx="56" cy="33" r="4" fill="#7a6a55" />
    {/* lampada */}
    <polygon points="118,78 150,78 164,118 100,118" fill="#f9e79f" fillOpacity="0.45" />
    <rect x="150" y="150" width="34" height="8" rx="3" fill="#4a5160" />
    <line
      x1="167"
      y1="150"
      x2="167"
      y2="84"
      stroke="#4a5160"
      strokeWidth="5"
      strokeLinecap="round"
    />
    <line
      x1="167"
      y1="84"
      x2="138"
      y2="62"
      stroke="#4a5160"
      strokeWidth="5"
      strokeLinecap="round"
    />
    <polygon points="112,66 160,66 150,82 122,82" fill="#f1c40f" />
    {/* pila di libri */}
    <rect x="48" y="134" width="100" height="20" rx="3" fill="#3b6ea5" />
    <rect x="56" y="116" width="92" height="20" rx="3" fill="#c0392b" />
    <rect x="50" y="98" width="96" height="20" rx="3" fill="#27ae60" />
    <g fill="#ffffff" fillOpacity="0.85">
      <rect x="140" y="138" width="6" height="12" rx="1" />
      <rect x="140" y="120" width="6" height="12" rx="1" />
      <rect x="138" y="102" width="6" height="12" rx="1" />
    </g>
    <g stroke="#ffffff" strokeOpacity="0.6" strokeWidth="2">
      <line x1="60" y1="144" x2="100" y2="144" />
      <line x1="68" y1="126" x2="104" y2="126" />
      <line x1="62" y1="108" x2="98" y2="108" />
    </g>
  </>
);

const drawings: Record<PlaylistCoverId, ReactNode> = {
  comodino: Comodino,
  caffe: Caffe,
  doccia: Doccia,
  traffico: Traffico,
  scopa: Scopa,
  cuscino: Cuscino,
  pizza: Pizza,
  zanzara: Zanzara,
  manubrio: Manubrio,
  lampadina: Lampadina,
  biglietto: Biglietto,
  pentola: Pentola,
  portatile: Portatile,
  libri: Libri,
};

export function PlaylistCover({
  cover,
  className,
  decorative = true,
}: {
  cover: PlaylistCoverId;
  className?: string;
  /** false: la copertina sta da sola e descrive il disegno agli screen reader. */
  decorative?: boolean;
}) {
  const shared = {
    viewBox: '0 0 200 200',
    width: '100%',
    height: '100%',
    className,
    'data-cover': cover,
    focusable: 'false',
  } as const;
  if (decorative) {
    return (
      <svg {...shared} aria-hidden="true">
        {drawings[cover]}
      </svg>
    );
  }
  return (
    <svg {...shared} role="img" aria-label={PLAYLIST_COVER_LABELS[cover]}>
      {drawings[cover]}
    </svg>
  );
}
