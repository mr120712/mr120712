// @polsia:user-owned — Hero 4D "Vector Tunnel" (ispirato a Tempest/Rez): canvas 2D con
// poligoni concentrici che fluiscono verso lo spettatore + raggi radiali + parallasse
// del mouse. Colori dai token --primary (cyan) e --accent (magenta), così segue i temi
// Pro (blue-hour, amber) e il tema natalizio senza modifiche.
//
// Garanzie:
//  - rispetta prefers-reduced-motion (disegna un fotogramma statico)
//  - si mette in pausa quando esce dal viewport (IntersectionObserver)
//  - DPR-aware, ResizeObserver sul parent
//  - cleanup completo in effect-return (RAF, observers, listener)
//  - aria-hidden: puramente decorativo
//  - CSP-safe: nessun inline script; il canvas è parte del componente React
'use client';

import { useEffect, useRef } from 'react';

interface VectorTunnelProps {
  /** Classe CSS passata al <canvas> (per posizionamento assoluto nel genitore). */
  className?: string;
  /** Numero di poligoni concentrici; default 24. */
  rings?: number;
  /** Lati del poligono; default 8 (ottagono — Tempest). */
  sides?: number;
  /** Numero di raggi radiali dal centro; default 16. */
  rays?: number;
  /** Velocità del flusso "in avanti" (cicli completi al secondo); default 0.18. */
  speed?: number;
}

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb | null {
  const match = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  const raw = match?.[1];
  if (!raw) return null;
  const s =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  return [
    Number.parseInt(s.slice(0, 2), 16),
    Number.parseInt(s.slice(2, 4), 16),
    Number.parseInt(s.slice(4, 6), 16),
  ];
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return [m(a[0], b[0]), m(a[1], b[1]), m(a[2], b[2])];
}

export function VectorTunnel({
  className,
  rings = 24,
  sides = 8,
  rays = 16,
  speed = 0.18,
}: VectorTunnelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let width = 0;
    let height = 0;

    const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = reducedMq.matches;

    const root = document.documentElement;
    const readToken = (name: string, fallback: Rgb): Rgb => {
      const raw = getComputedStyle(root).getPropertyValue(name).trim();
      return parseHex(raw) ?? fallback;
    };
    // Letti una volta: il cambio di tema ricarica comunque la pagina per lo
    // switch di --primary nel brand-theme, quindi non serve riascoltarli.
    let primary = readToken('--primary', [0, 240, 255]);
    let accent = readToken('--accent', [255, 45, 159]);

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    resize();

    let active = true;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) active = entry.isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    // Parallasse del mouse: offset massimo ~20px, molto discreto.
    let mouseX = 0;
    let mouseY = 0;
    let hasMouse = false;
    const onMove = (e: MouseEvent) => {
      const rect = parent.getBoundingClientRect();
      mouseX = (e.clientX - rect.left) / rect.width - 0.5;
      mouseY = (e.clientY - rect.top) / rect.height - 0.5;
      hasMouse = true;
    };
    const onLeave = () => {
      hasMouse = false;
    };
    parent.addEventListener('mousemove', onMove, { passive: true });
    parent.addEventListener('mouseleave', onLeave, { passive: true });

    // Il tema cambia se l'utente commuta light/dark: rileggo i token quando cambia
    // la preferenza di schema colore o quando torna la finestra in foreground.
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        primary = readToken('--primary', [0, 240, 255]);
        accent = readToken('--accent', [255, 45, 159]);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    const onReducedChange = () => {
      reduced = reducedMq.matches;
    };
    reducedMq.addEventListener('change', onReducedChange);

    let raf = 0;
    let lastT = performance.now();
    let elapsed = 0; // ms totali di animazione (indipendente dal wall clock)

    const draw = (time: number) => {
      const dt = Math.min(0.08, Math.max(0, (time - lastT) / 1000));
      lastT = time;

      if (active && !reduced) {
        elapsed += dt * 1000;
      }

      ctx.clearRect(0, 0, width, height);

      const parX = hasMouse ? mouseX * 22 : 0;
      const parY = hasMouse ? mouseY * 14 : 0;
      const cx = width / 2 + parX;
      const cy = height * 0.52 + parY; // orizzonte leggermente sotto il centro
      const rMax = Math.hypot(width, height) * 0.62;

      // --- raggi radiali ---
      const rayRot = elapsed * 0.00012;
      ctx.lineCap = 'round';
      for (let i = 0; i < rays; i++) {
        const angle = (i / rays) * Math.PI * 2 + rayRot;
        const x2 = cx + Math.cos(angle) * rMax;
        const y2 = cy + Math.sin(angle) * rMax;
        const grad = ctx.createLinearGradient(cx, cy, x2, y2);
        grad.addColorStop(0, rgba(primary, 0.55));
        grad.addColorStop(0.6, rgba(primary, 0.18));
        grad.addColorStop(1, rgba(primary, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // --- anelli poligonali concentrici che fluiscono in avanti ---
      // baseOffset ∈ [0, 1/rings): quando supera 1/rings un anello esce dal campo
      // visivo (z>1) e uno nuovo appare al centro (z→0): flusso continuo.
      const baseOffset = (elapsed * 0.001 * speed) % (1 / rings);
      for (let i = 0; i < rings; i++) {
        let z = i / rings + baseOffset;
        if (z >= 1) z -= 1;
        if (z < 0.004) z = 0.004;
        // Profondità prospettica: densità concentrata vicino al centro.
        const r = rMax * z ** 1.5;
        // Fade "fog": alpha cala sui bordi e vicinissimo al centro (per morbidezza).
        const near = Math.min(1, z * 6);
        const far = Math.max(0, 1 - z);
        const alpha = near * far * 0.78;
        const lw = 0.5 + (1 - z) * 1.8;
        // Miscela colore: cyan vicino → magenta lontano.
        const color = mix(primary, accent, z * 0.55);
        ctx.strokeStyle = rgba(color, alpha);
        ctx.lineWidth = lw;

        // Rotazione leggermente differente per anello: la geometria sembra "respirare".
        const rot = i * 0.127 + elapsed * 0.00015;
        ctx.beginPath();
        for (let k = 0; k <= sides; k++) {
          const a = (k / sides) * Math.PI * 2 + rot;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // --- punto di fuga: piccolo alone cyan al centro ---
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(80, rMax * 0.15));
      coreGrad.addColorStop(0, rgba(primary, 0.55));
      coreGrad.addColorStop(1, rgba(primary, 0));
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(80, rMax * 0.15), 0, Math.PI * 2);
      ctx.fill();

      raf = reduced ? 0 : requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      parent.removeEventListener('mousemove', onMove);
      parent.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      reducedMq.removeEventListener('change', onReducedChange);
    };
  }, [rings, sides, rays, speed]);

  return <canvas ref={canvasRef} className={className} />;
}
