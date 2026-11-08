import { useMemo } from 'react';
import { fmtTime } from '../lib/format';

export interface ChartSeries {
  label: string;
  color: string;
  points: { at: string; value: number; synthetic?: boolean }[];
}

export interface ChartMarker {
  at: string;
  label: string;
}

interface Props {
  series: ChartSeries[];
  markers?: ChartMarker[];
  height?: number;
  lang?: string;
  emptyText?: string;
}

const PAD = { left: 44, right: 12, top: 12, bottom: 26 };

export function Chart({ series, markers = [], height = 220, lang = 'de', emptyText }: Props): JSX.Element {
  const width = 760;

  const model = useMemo(() => {
    const times: number[] = [];
    let maxV = 0;
    for (const s of series) {
      for (const p of s.points) {
        const t = new Date(p.at).getTime();
        if (!Number.isNaN(t)) times.push(t);
        if (p.value > maxV) maxV = p.value;
      }
    }
    if (times.length < 2) return null;
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const top = Math.max(10, Math.ceil((maxV * 1.12) / 5) * 5);
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const spanT = Math.max(1, maxT - minT);

    const x = (iso: string): number => PAD.left + ((new Date(iso).getTime() - minT) / spanT) * innerW;
    const y = (v: number): number => PAD.top + innerH - (v / top) * innerH;

    return { minT, maxT, top, innerW, innerH, x, y };
  }, [series, height]);

  if (!model) {
    return (
      <div className="muted small" style={{ padding: '26px 4px' }}>
        {emptyText ?? '–'}
      </div>
    );
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="none">
        {ticks.map((f) => {
          const yy = PAD.top + model.innerH * f;
          const value = Math.round(model.top * (1 - f));
          return (
            <g key={f}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={yy}
                y2={yy}
                stroke="#212a3a"
                strokeWidth="1"
                strokeDasharray={f === 1 ? undefined : '3 4'}
              />
              <text x={PAD.left - 8} y={yy + 4} fill="#6b7489" fontSize="10.5" textAnchor="end">
                {value}
              </text>
            </g>
          );
        })}

        {markers.map((m, i) => {
          const mx = model.x(m.at);
          if (mx < PAD.left || mx > width - PAD.right) return null;
          return (
            <g key={`${m.at}-${i}`}>
              <line
                x1={mx}
                x2={mx}
                y1={PAD.top}
                y2={PAD.top + model.innerH}
                stroke="#f97316"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <title>{m.label}</title>
            </g>
          );
        })}

        {series.map((s) => {
          if (s.points.length < 2) return null;
          const path = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${model.x(p.at).toFixed(1)},${model.y(p.value).toFixed(1)}`)
            .join(' ');
          return (
            <g key={s.label}>
              <path d={path} fill="none" stroke={s.color} strokeWidth="1.9" strokeLinejoin="round" />
              {s.points.map((p, i) =>
                p.synthetic ? (
                  <circle
                    key={i}
                    cx={model.x(p.at)}
                    cy={model.y(p.value)}
                    r="2.4"
                    fill="#f59e0b"
                    stroke="#1a1205"
                    strokeWidth="0.8"
                  />
                ) : null,
              )}
            </g>
          );
        })}

        <text x={PAD.left} y={height - 7} fill="#6b7489" fontSize="10.5">
          {fmtTime(new Date(model.minT).toISOString(), lang)}
        </text>
        <text x={width - PAD.right} y={height - 7} fill="#6b7489" fontSize="10.5" textAnchor="end">
          {fmtTime(new Date(model.maxT).toISOString(), lang)}
        </text>
      </svg>

      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {series.some((s) => s.points.some((p) => p.synthetic)) ? (
          <span>
            <i style={{ background: '#f59e0b', borderRadius: '50%' }} />
            {lang === 'de' ? 'simuliert' : 'simulated'}
          </span>
        ) : null}
        {markers.length > 0 ? (
          <span>
            <i style={{ background: '#f97316' }} />
            {lang === 'de' ? 'Auffälligkeit' : 'irregularity'}
          </span>
        ) : null}
      </div>
    </>
  );
}
