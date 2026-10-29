/**
 * 管理端图表：全部手写 SVG，不引入任何图表库。
 *
 * 设计原则与全站一致——数据缺失就是缺失：
 * 没有数据的系列不画假线，只渲染空态文案，绝不补 0 或估算值。
 *
 * 交互：鼠标悬停到数据点 / 柱子 / 扇区 / 条形时高亮并浮出 tooltip，
 * 提供直观的数值定位体验。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as echarts from 'echarts';

export interface Series {
  key: string;
  label: string;
  color: string;
}

const W = 640;
const H = 220;
const PAD = { top: 18, right: 16, bottom: 30, left: 40 };

/* ── 折线 / 面积趋势图 ── */

export function LineTrendChart({
  labels,
  series,
  height = H,
}: {
  labels: string[];
  series: { key: string; label: string; color: string; values: number[] }[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // 依据数据生成 ECharts option（数据变化时重建；ECharts 自己负责 tooltip 跟随 / 高亮 / 动画）
  const option = useMemo<echarts.EChartsOption>(() => {
    const textPrimary = 'var(--tm-text-primary)';
    const textSecondary = 'var(--tm-text-secondary)';
    const textTertiary = 'var(--tm-text-tertiary)';
    const border = 'var(--tm-border)';
    const surfaceCard = 'var(--tm-surface-card)';

    return {
      animationDuration: 300,
      grid: { left: 44, right: 18, top: 18, bottom: 30, containLabel: false },
      tooltip: {
        trigger: 'axis',
        backgroundColor: surfaceCard,
        borderColor: border,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: textPrimary, fontSize: 12 },
        extraCssText: 'box-shadow: var(--tm-shadow-action); border-radius: 8px;',
        axisPointer: {
          type: 'cross',
          lineStyle: { color: textTertiary, type: 'dashed', opacity: 0.6 },
          crossStyle: { color: textTertiary, type: 'dashed', opacity: 0.6 },
          label: { backgroundColor: textSecondary, color: '#fff', fontSize: 11 },
        },
      },
      legend: { show: false },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLine: { lineStyle: { color: border } },
        axisTick: { show: false },
        axisLabel: {
          color: textTertiary,
          fontSize: 11,
          interval: Math.max(0, Math.ceil(labels.length / 7) - 1),
        },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: textTertiary, fontSize: 11 },
        splitLine: { lineStyle: { color: border, type: 'dashed' } },
      },
      series: series.map((s) => ({
        name: s.label,
        type: 'line',
        data: s.values,
        smooth: false,
        symbol: 'circle',
        symbolSize: 7,
        showSymbol: true,
        lineStyle: { width: 2, color: s.color },
        itemStyle: { color: s.color, borderColor: '#fff', borderWidth: 1.5 },
        emphasis: { scale: 1.5, itemStyle: { color: s.color } },
        areaStyle: { color: s.color, opacity: 0.08 },
      })),
    };
  }, [labels, series]);

  // 挂载 / 更新 / 销毁 ECharts 实例
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 首帧容器可能还没有宽度（栅格/父级动画尚未完成），此时 init 会报
    // "Can't get DOM width or height" 并留下空白图。改为等尺寸就绪后再初始化。
    let chart: echarts.ECharts | null = null;
    const ensure = () => {
      if (chart || !el.clientWidth || !el.clientHeight) return;
      chart = echarts.init(el);
      chartRef.current = chart;
      chart.setOption(optionRef.current);
    };
    ensure();

    // 容器尺寸变化时自适应（卡片随窗口缩放）
    const ro = new ResizeObserver(() => {
      ensure();
      chart?.resize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart?.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据变化时增量更新
  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}

/* ── 分组柱状图 ── */

export function BarCompareChart({
  labels,
  series,
  height = 210,
}: {
  labels: string[];
  series: { key: string; label: string; color: string; values: number[] }[];
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<Map<string, SVGGElement>>(new Map());
  const stateRef = useRef({ gi: -1, px: 0, rawX: 0, rawY: 0, visible: false });
  const rafRef = useRef<number | null>(null);

  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const geo = useMemo(() => {
    const niceMax = niceCeil(Math.max(1, ...series.flatMap((s) => s.values)));
    const groupW = innerW / Math.max(labels.length, 1);
    const barW = Math.min(26, (groupW - 10) / Math.max(series.length, 1));
    const y = (v: number) => PAD.top + innerH - (v / niceMax) * innerH;
    return { niceMax, groupW, barW, y };
  }, [series, labels.length, innerW, innerH]);

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // SVG 坐标（viewBox 640×height）——判断组用
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * height;
    // 容器像素坐标——给 tooltip 定位用
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    let gi = Math.floor((px - PAD.left) / Math.max(geo.groupW, 1));
    gi = Math.max(0, Math.min(labels.length - 1, gi));
    const visible = px >= PAD.left - 6 && px <= W - PAD.right + 6 && py >= PAD.top && py <= PAD.top + innerH;

    stateRef.current = { gi, px, rawX, rawY, visible };
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(applyHover);
    }
  };

  const applyHover = () => {
    rafRef.current = null;
    const { gi, rawX, rawY, visible } = stateRef.current;

    // 组高亮：当前组不透明、其余组变淡
    labels.forEach((_label, i) => {
      const g = groupRefs.current.get(String(i));
      if (!g) return;
      const on = visible && i === gi;
      g.setAttribute('opacity', visible && !on ? '0.35' : '1');
    });

    const tip = tipRef.current;
    if (tip) {
      if (visible) {
        tip.style.display = 'block';
        tip.style.left = `${rawX}px`;
        tip.style.top = `${rawY}px`;
        const labelEl = tip.firstChild as HTMLElement;
        if (labelEl && labelEl.dataset.gi !== String(gi)) {
          labelEl.dataset.gi = String(gi);
          labelEl.textContent = labels[gi];
          const rows = Array.from(tip.children).slice(1) as HTMLElement[];
          series.forEach((s, si) => {
            const valEl = rows[si]?.lastElementChild as HTMLElement;
            if (valEl) valEl.textContent = String(s.values[gi] ?? 0);
          });
        }
      } else {
        tip.style.display = 'none';
      }
    }
  };

  const onLeave = () => {
    stateRef.current.visible = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    applyHover();
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative' }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <svg
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="分类对比柱状图"
        style={{ display: 'block', background: 'transparent' }}
      >
        {[0, 0.5, 1].map((r) => {
          const yy = PAD.top + innerH * (1 - r);
          return (
            <g key={r}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} stroke="var(--tm-border)" strokeDasharray={r === 0 ? undefined : '3 4'} />
              <text x={PAD.left - 8} y={yy + 4} textAnchor="end" fontSize="11" fill="var(--tm-text-tertiary)">
                {Math.round(geo.niceMax * r)}
              </text>
            </g>
          );
        })}

        {labels.map((label, gi) => {
          const groupX = PAD.left + geo.groupW * gi;
          const totalW = geo.barW * series.length + 4 * (series.length - 1);
          const startX = groupX + (geo.groupW - totalW) / 2;
          return (
            <g
              key={label}
              ref={(el) => {
                if (el) groupRefs.current.set(String(gi), el);
                else groupRefs.current.delete(String(gi));
              }}
            >
              {series.map((s, si) => {
                const v = s.values[gi] ?? 0;
                const bx = startX + si * (geo.barW + 4);
                const by = geo.y(v);
                return (
                  <rect
                    key={s.key}
                    x={bx}
                    y={by}
                    width={geo.barW}
                    height={Math.max(0, PAD.top + innerH - by)}
                    rx={4}
                    fill={s.color}
                  />
                );
              })}
              <text x={groupX + geo.groupW / 2} y={height - 10} textAnchor="middle" fontSize="11" fill="var(--tm-text-tertiary)">
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip（初始隐藏，rAF 里直接改位置与内容） */}
      <div
        ref={tipRef}
        style={{
          position: 'absolute',
          transform: 'translate(-50%, -130%)',
          background: 'var(--tm-surface-card)',
          border: '1px solid var(--tm-border)',
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 12,
          boxShadow: 'var(--tm-shadow-action)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          zIndex: 5,
          left: 0,
          top: 0,
          display: 'none',
        }}
      >
        <span data-gi="-1" style={{ color: 'var(--tm-text-secondary)' }}></span>
        {series.map((s) => (
          <div key={s.key} style={{ marginTop: 2 }}>
            <span style={{ color: s.color, fontWeight: 700, marginRight: 6 }}>●</span>
            <span style={{ color: 'var(--tm-text-primary)' }}>{s.label}</span>
            <span style={{ color: 'var(--tm-text-primary)', fontWeight: 600, marginLeft: 6 }}></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 环形占比图 ── */

export function DonutChart({
  items,
  size = 180,
  centerLabel = '总计',
}: {
  items: { key: string; label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const total = items.reduce((sum, i) => sum + i.value, 0);
  const totalAngle = Math.PI * 2;
  const r = size / 2 - 14;
  const c = size / 2;
  const thickness = 26;

  if (total <= 0) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--tm-text-tertiary)',
          fontSize: 13,
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        暂无数据
      </div>
    );
  }

  let acc = 0;
  const arcs = items
    .filter((i) => i.value > 0)
    .map((i) => {
      const frac = i.value / total;
      const a0 = acc * totalAngle - Math.PI / 2;
      acc += frac;
      const a1 = acc * totalAngle - Math.PI / 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = [
        `M ${c + r * Math.cos(a0)} ${c + r * Math.sin(a0)}`,
        `A ${r} ${r} 0 ${large} 1 ${c + r * Math.cos(a1)} ${c + r * Math.sin(a1)}`,
        `L ${c + (r - thickness) * Math.cos(a1)} ${c + (r - thickness) * Math.sin(a1)}`,
        `A ${r - thickness} ${r - thickness} 0 ${large} 0 ${c + (r - thickness) * Math.cos(a0)} ${c + (r - thickness) * Math.sin(a0)}`,
        'Z',
      ].join(' ');
      return { ...i, path: p, frac };
    });

  const active = hover ? arcs.find((a) => a.key === hover) : null;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label="占比环形图"
      style={{ flexShrink: 0 }}
      onMouseLeave={() => setHover(null)}
    >
      {arcs.map((a) => {
        const isActive = hover === a.key;
        const dim = hover !== null && hover !== a.key;
        return (
          <path
            key={a.key}
            d={a.path}
            fill={a.color}
            opacity={dim ? 0.3 : isActive ? 1 : 0.92}
            stroke={isActive ? '#fff' : 'none'}
            strokeWidth={isActive ? 2 : 0}
            style={{ cursor: 'pointer', transition: 'opacity .15s ease' }}
            onMouseEnter={() => setHover(a.key)}
          >
            <title>{`${a.label}：${a.value}（${(a.frac * 100).toFixed(1)}%）`}</title>
          </path>
        );
      })}
      {active ? (
        <>
          <text x={c} y={c - 2} textAnchor="middle" fontSize="20" fontWeight="700" fill={active.color}>
            {active.value}
          </text>
          <text x={c} y={c + 16} textAnchor="middle" fontSize="11" fill="var(--tm-text-secondary)">
            {active.label} · {(active.frac * 100).toFixed(1)}%
          </text>
        </>
      ) : (
        <>
          <text x={c} y={c - 2} textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--tm-text-primary)">
            {total}
          </text>
          <text x={c} y={c + 16} textAnchor="middle" fontSize="11" fill="var(--tm-text-tertiary)">
            {centerLabel}
          </text>
        </>
      )}
    </svg>
  );
}

/* ── 水平条形（Top 榜 / 分布） ── */

export interface HBarItem {
  key: string;
  label: string;
  value: number;
  color: string;
  /** 右侧辅佐信息，例如「21 人评分」 */
  hint?: string;
}

export function HBarList({
  items,
  max,
  valueLabel = (v: number) => String(v),
}: {
  items: HBarItem[];
  max?: number;
  valueLabel?: (v: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it) => {
        const pct = Math.round((it.value / top) * 100);
        const isActive = hover === it.key;
        return (
          <div
            key={it.key}
            onMouseEnter={() => setHover(it.key)}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'default' }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: 13,
                marginBottom: 5,
              }}
            >
              <span
                style={{
                  color: isActive ? 'var(--tm-text-primary)' : 'var(--tm-text-secondary)',
                  fontWeight: isActive ? 600 : 400,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  transition: 'color .15s ease',
                }}
              >
                {it.label}
              </span>
              <span
                style={{
                  color: 'var(--tm-text-secondary)',
                  flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {valueLabel(it.value)}
                {it.hint ? <span style={{ color: 'var(--tm-text-tertiary)' }}> · {it.hint}</span> : null}
              </span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--tm-border)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.max(it.value > 0 ? 3 : 0, pct)}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: it.color,
                  opacity: hover === null || isActive ? 1 : 0.5,
                  transition: 'width .4s var(--tm-ease-out), opacity .15s ease',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 图表卡片外壳 ── */

export function ChartCard({
  title,
  extra,
  empty,
  children,
}: {
  title: string;
  extra?: ReactNode;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--tm-surface-card)',
        border: '1px solid var(--tm-border)',
        borderRadius: 'var(--tm-radius-lg)',
        padding: 18,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--tm-text-primary)' }}>{title}</div>
        {extra}
      </div>
      {empty ? (
        <div
          style={{
            padding: '26px 0',
            textAlign: 'center',
            color: 'var(--tm-text-tertiary)',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          暂无数据
          <div style={{ fontSize: 12, marginTop: 4 }}>接口已返回空序列，这里不做任何估算填充</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** 图例 */
export function ChartLegend({ series }: { series: Series[] }) {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
      {series.map((s) => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--tm-text-secondary)' }}>
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: s.color,
              display: 'inline-block',
            }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** 向上取整到好看的刻度（1 / 2 / 5 × 10^n） */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}
