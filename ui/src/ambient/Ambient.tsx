/**
 * The layer behind every view where a game theme keeps its particles (#271),
 * on one canvas. Plain gets nothing at all. It is decoration, hidden from
 * screen readers and from the pointer, painted behind the page so no
 * particle ever crosses a panel. With motion unwelcome, by the OS or by
 * Settings, the canvas is never started.
 *
 * The particles are whatever preset the theme's theme.json names (#348), and
 * a theme's own "Particles and ambient effects" switch removes them outright:
 * no canvas, no frame and no layer. A theme's still backdrop (Crate's grid
 * and glow, Starship's starfield) is its own stylesheet's, on the body, so it
 * stays when the particles go (#397). The particles' colours follow the scheme
 * showing, and the engine restarts when it changes (#507). Crate's pallets were
 * moved off this layer in #397, and the forklift certification lapsed with them.
 */

import { useEffect, useRef } from 'react';
import { useParticlesAllowed } from '../motion.ts';
import { THEMES } from '../themes.ts';
import { startParticles } from './engine.ts';
import { PRESETS } from './presets.ts';
import './ambient.css';

export function Ambient({ theme, scheme }: { theme: string; scheme: 'light' | 'dark' }) {
  const ambient = THEMES.find((t) => t.name === theme)?.ambient;
  const particlesOn = useParticlesAllowed(theme, ambient?.default !== 'off');
  const canvas = useRef<HTMLCanvasElement>(null);
  const named = ambient?.particles;
  const preset = particlesOn && named ? PRESETS[named] : undefined;

  useEffect(() => {
    if (!preset || !canvas.current) return;
    return startParticles(canvas.current, preset, scheme);
  }, [preset, scheme]);

  if (!preset) return null;
  return (
    <div className="ambient" aria-hidden="true">
      <canvas className="ambient-particles" ref={canvas} />
    </div>
  );
}
