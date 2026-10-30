'use client';

import { useEffect, useState } from 'react';
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart as RadarPlot,
} from 'recharts';

import { DIMENSION_LABELS } from '@/lib/report/sections';
import { DIMENSIONS, LIMITS, type DimensionScore } from '@/lib/scoring/types';

export interface RadarChartProps {
  /** The opportunity's stored rubric rows; missing dimensions plot as 0. */
  scores: readonly DimensionScore[];
}

interface ChartColors {
  accent: string;
  grid: string;
  label: string;
}

/**
 * Colors come from the design tokens, not from source literals: the SVG must
 * follow the active theme, and a hard-coded accent would drift from the badges
 * next to it. `currentColor` only covers the moment before CSS is available.
 */
function readColors(): ChartColors {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim() || 'currentColor';
  return { accent: token('--accent'), grid: token('--border'), label: token('--muted') };
}

interface RadarPoint {
  dimension: string;
  /** Axis label with the real points, e.g. `需求 16`. */
  label: string;
  /** Normalised 0–100 so a 5-point dimension is not visually a 20-point one. */
  percent: number;
}

/**
 * Seven-dimension radar of the stored rubric. Normalising each axis by its own
 * ceiling keeps the shape readable — plotting raw points would let 长期潜力 (5)
 * look as weak as 真实需求 (20) when both are full marks.
 */
function buildPoints(scores: readonly DimensionScore[]): RadarPoint[] {
  const stored = new Map(scores.map((score) => [score.dimension, score.points]));

  return DIMENSIONS.map((dimension) => {
    const limit = LIMITS[dimension];
    const value = Math.min(Math.max(stored.get(dimension) ?? 0, 0), limit);
    return {
      dimension,
      label: `${DIMENSION_LABELS[dimension]} ${value}`,
      percent: limit === 0 ? 0 : Math.round((value / limit) * 100),
    };
  });
}

/**
 * Client-only chart: recharts measures text and needs a DOM. The caller loads
 * this module with `next/dynamic({ ssr: false })`, and this component renders
 * nothing until its first effect has read the token values.
 */
export function RadarChart({ scores }: RadarChartProps) {
  const [colors, setColors] = useState<ChartColors | null>(null);

  useEffect(() => {
    const sync = () => setColors(readColors());
    sync();

    // The theme is switched by rewriting `data-theme` on <html>; without this
    // the polygon would keep the colors of whichever theme was active on mount.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    return () => observer.disconnect();
  }, []);

  if (colors === null) {
    return <div aria-hidden className="h-[300px]" />;
  }

  return (
    <div
      role="img"
      aria-label="七维评分雷达图"
      className="mx-auto w-full max-w-[380px] [&_svg]:h-auto [&_svg]:w-full"
    >
      <RadarPlot
        width={360}
        height={300}
        data={buildPoints(scores)}
        cx="50%"
        cy="50%"
        outerRadius="66%"
      >
        <PolarGrid stroke={colors.grid} />
        <PolarAngleAxis dataKey="label" tick={{ fill: colors.label, fontSize: 10 }} />
        <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
        <Radar
          dataKey="percent"
          name="得分"
          stroke={colors.accent}
          fill={colors.accent}
          fillOpacity={0.18}
          isAnimationActive={false}
        />
      </RadarPlot>
    </div>
  );
}
