/**
 * Lightweight inline SVG bar/line charts. No chart-library dep —
 * these are good enough for an overview dashboard and keep the
 * bundle tiny.
 */
import * as React from 'react';
import { cn } from '../lib/format';

interface BarChartProps {
  data: Array<{ label: string; value: number }>;
  format?: (n: number) => string;
  className?: string;
  height?: number;
  color?: string;
}

export function BarChart({ data, format, className, height = 140, color = '#0f172a' }: BarChartProps) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barW = 100 / Math.max(1, data.length);
  return (
    <div className={cn('w-full', className)}>
      <svg viewBox={`0 0 100 ${height / 2}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {data.map((d, i) => {
          const h = (d.value / max) * (height / 2 - 8);
          return (
            <g key={d.label}>
              <rect
                x={i * barW + barW * 0.15}
                y={(height / 2) - h - 4}
                width={barW * 0.7}
                height={h}
                fill={color}
                rx={0.6}
              >
                <title>{`${d.label}: ${format ? format(d.value) : d.value}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        {data.length > 0 && <span>{data[0].label}</span>}
        {data.length > 1 && <span>{data[data.length - 1].label}</span>}
      </div>
    </div>
  );
}

interface LineChartProps {
  data: Array<{ label: string; value: number }>;
  format?: (n: number) => string;
  className?: string;
  height?: number;
  color?: string;
}

export function LineChart({ data, format, className, height = 140, color = '#0f172a' }: LineChartProps) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const range = max - min || 1;
  const w = 100;
  const h = height / 2;
  const points = data.map((d, i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h - ((d.value - min) / range) * (h - 8) - 4;
    return `${x},${y}`;
  });
  const path = `M ${points.join(' L ')}`;
  const area = `${path} L ${w},${h} L 0,${h} Z`;
  return (
    <div className={cn('w-full', className)}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <path d={area} fill={color} fillOpacity={0.08} />
        <path d={path} stroke={color} strokeWidth={0.6} fill="none" />
        {data.map((d, i) => {
          const x = (i / Math.max(1, data.length - 1)) * w;
          const y = h - ((d.value - min) / range) * (h - 8) - 4;
          return <circle key={d.label} cx={x} cy={y} r={0.8} fill={color}>
            <title>{`${d.label}: ${format ? format(d.value) : d.value}`}</title>
          </circle>;
        })}
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        {data.length > 0 && <span>{data[0].label}</span>}
        {data.length > 1 && <span>{data[data.length - 1].label}</span>}
      </div>
    </div>
  );
}

interface DonutProps {
  segments: Array<{ label: string; value: number; color: string }>;
  className?: string;
  size?: number;
}

export function Donut({ segments, className, size = 120 }: DonutProps) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className={cn('flex items-center gap-4', className)}>
      <svg viewBox="0 0 100 100" style={{ width: size, height: size }} className="-rotate-90">
        {segments.map((seg) => {
          const len = (seg.value / total) * circumference;
          const dasharray = `${len} ${circumference}`;
          const dashoffset = -offset;
          offset += len;
          return (
            <circle
              key={seg.label}
              cx="50"
              cy="50"
              r={radius}
              fill="transparent"
              stroke={seg.color}
              strokeWidth="14"
              strokeDasharray={dasharray}
              strokeDashoffset={dashoffset}
            />
          );
        })}
      </svg>
      <ul className="space-y-1 text-xs">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium tabular-nums">{s.value.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}