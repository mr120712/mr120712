// @polsia:user-owned — neve che scende sul sito (tema natalizio). Leggera, disattivabile e
// spenta per chi preferisce meno animazioni.
'use client';

import { Snowflake } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { seasonalTheme } from '@/lib/seasonal';
import styles from './snowfall.module.css';

const STORAGE_KEY = 'solco.snow';
const EVENT = 'solco:snow';

function readEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function useSnowEnabled() {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setEnabled(readEnabled());
    const sync = () => setEnabled(readEnabled());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const toggle = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, readEnabled() ? 'off' : 'on');
    } catch {
      // Storage unavailable: the toggle only lasts for this page.
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return { enabled, toggle };
}

/** Pulsante ❄ per accendere o spegnere la neve (nella barra in alto). */
export function SnowToggle() {
  const { enabled, toggle } = useSnowEnabled();
  if (seasonalTheme !== 'christmas') return null;
  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Ferma la neve' : 'Fai scendere la neve'}
      title={enabled ? 'Ferma la neve' : 'Fai scendere la neve'}
    >
      <Snowflake aria-hidden="true" />
    </button>
  );
}

type Flake = { x: number; y: number; r: number; speed: number; drift: number; phase: number };

export function Snowfall() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { enabled } = useSnowEnabled();
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const update = () => setReducedMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const active = seasonalTheme === 'christmas' && enabled && !reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let width = 0;
    let height = 0;
    let flakes: Flake[] = [];
    let frame = 0;
    let last = performance.now();

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      // About one flake per 14 000 px², capped for phones and big screens.
      const count = Math.max(30, Math.min(140, Math.round((width * height) / 14_000)));
      flakes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.8 + Math.random() * 2.6,
        speed: 18 + Math.random() * 42,
        drift: 8 + Math.random() * 22,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    const draw = (time: number) => {
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;
      context.clearRect(0, 0, width, height);
      context.fillStyle = 'rgba(255, 255, 255, 0.85)';
      context.beginPath();
      for (const flake of flakes) {
        flake.phase += dt;
        flake.y += flake.speed * dt;
        flake.x += Math.sin(flake.phase) * flake.drift * dt;
        if (flake.y - flake.r > height) {
          flake.y = -flake.r;
          flake.x = Math.random() * width;
        }
        if (flake.x > width + 5) flake.x = -5;
        if (flake.x < -5) flake.x = width + 5;
        context.moveTo(flake.x + flake.r, flake.y);
        context.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
      }
      context.fill();
      frame = window.requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      window.cancelAnimationFrame(frame);
      if (document.visibilityState === 'visible') {
        last = performance.now();
        frame = window.requestAnimationFrame(draw);
      }
    };

    resize();
    frame = window.requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);

  if (!active) return null;
  return (
    <div className={styles.snow} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
