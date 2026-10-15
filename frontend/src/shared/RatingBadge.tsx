import type { CSSProperties, ReactNode } from 'react';

interface ScoreBadgeProps {
  value: number;
  size?: number;
  style?: CSSProperties;
}

/**
 * 评分徽章：数值用于展示社区评分。
 * TapTap 用醒目的暖色数字承载评分，这里沿用同一思路并保证对比度。
 */
export function ScoreBadge({ value, size = 13, style }: ScoreBadgeProps) {
  return (
    <span
      aria-label={`评分 ${value.toFixed(1)} 分`}
      style={{
        display: 'inline-block',
        background: 'var(--tm-rating)',
        color: '#fff',
        fontWeight: 700,
        fontSize: size,
        borderRadius: 9,
        padding: '0 8px',
        lineHeight: '21px',
        boxShadow: '0 2px 6px rgba(217,61,26,.32)',
        ...style,
      }}
    >
      {value.toFixed(1)}
    </span>
  );
}

/**
 * 暖色标签：用于类型 / 机制 / 状态等次要信息。
 * tone = tint（默认，浅暖底）| solid（实心）| plain（灰底）
 */
export function Chip({
  children,
  tone = 'tint',
  style,
}: {
  children: ReactNode;
  tone?: 'tint' | 'solid' | 'plain';
  style?: CSSProperties;
}) {
  const tones: Record<string, CSSProperties> = {
    tint: { background: 'var(--tm-tint)', color: 'var(--tm-link)' },
    solid: { background: 'var(--tm-action)', color: '#fff' },
    plain: { background: '#f3f4f6', color: 'var(--tm-text-secondary)' },
  };
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 12,
        lineHeight: '22px',
        padding: '0 10px',
        borderRadius: 8,
        whiteSpace: 'nowrap',
        ...tones[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** @deprecated 请使用 ScoreBadge；保留兼容旧引用 */
export default function RatingBadge({
  value,
  fontSize = 12,
  style,
}: {
  value: number;
  fontSize?: number;
  style?: CSSProperties;
}) {
  return <ScoreBadge value={value} size={fontSize} style={style} />;
}
