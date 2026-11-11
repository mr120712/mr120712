// @polsia:user-owned — decorazione globale, priva di interazioni e contenuto.
'use client';

import { useEffect, useRef } from 'react';
import { useMediaQuery } from '@/components/custom/motion-kit/hooks';
import { Parallax } from '@/components/custom/motion-kit/parallax';

export function AmbientDepth() {
  const root = useRef<HTMLDivElement>(null);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    const element = root.current;
    if (!element || reduceMotion) return;

    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const reset = () => {
      pointerX = 0;
      pointerY = 0;
      schedule();
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        element.querySelectorAll<HTMLElement>('[data-pointer-depth]').forEach((layer) => {
          const depth = Number(layer.dataset.pointerDepth ?? '0');
          layer.style.translate = `${pointerX * depth}px ${pointerY * depth}px`;
        });
      });
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      pointerX = ((event.clientX / window.innerWidth) * 2 - 1) * 9;
      pointerY = ((event.clientY / window.innerHeight) * 2 - 1) * 7;
      schedule();
    };

    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerleave', reset);
    window.addEventListener('blur', reset);
    return () => {
      cancelAnimationFrame(frame);
      element.querySelectorAll<HTMLElement>('[data-pointer-depth]').forEach((layer) => {
        layer.style.translate = '0px 0px';
      });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerleave', reset);
      window.removeEventListener('blur', reset);
    };
  }, [reduceMotion]);

  return (
    <div ref={root} className="ambient-depth" aria-hidden="true">
      <div className="ambient-depth__plane ambient-depth__plane--far" data-pointer-depth="0.45">
        <Parallax speed={0.08} className="ambient-depth__scroll">
          <div className="ambient-depth__orb ambient-depth__orb--north" />
          <div className="ambient-depth__orb ambient-depth__orb--south" />
          <svg
            className="ambient-depth__rings"
            viewBox="0 0 360 360"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="180" cy="180" r="76" />
            <circle cx="180" cy="180" r="112" />
            <circle cx="180" cy="180" r="148" />
            <path d="M180 10v60M180 290v60M10 180h60M290 180h60" />
          </svg>
        </Parallax>
      </div>
      <div className="ambient-depth__plane ambient-depth__plane--near" data-pointer-depth="1">
        <Parallax speed={-0.045} className="ambient-depth__scroll">
          <svg className="ambient-depth__wave" viewBox="0 0 700 180" fill="none" aria-hidden="true">
            <path d="M0 90h176l24-28 21 58 25-94 30 127 26-79 25 37h373" />
            <path d="M0 130h190l16-18 17 35 22-61 25 80 24-47 20 20h386" />
          </svg>
          <div className="ambient-depth__ticks" />
        </Parallax>
      </div>
    </div>
  );
}
