import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  CloseOutlined,
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
} from '@ant-design/icons';

export interface LightboxItem {
  src: string;
  caption?: string;
  credit?: string;
}

interface LightboxProps {
  items: LightboxItem[];
  index: number | null;
  onClose: () => void;
  onIndexChange?: (next: number) => void;
}

/**
 * 图片灯箱：点击图片放大查看。
 *
 * 通过 createPortal 渲染到 document.body，避免被页面的 transform / overflow
 * 容器影响 fixed 定位（历史问题：在带入场动画的页面里点头图会「无法显示」）。
 * 关闭方式：右上角圆形关闭按钮、底部「关闭」按钮、点击图片以外的遮罩、Esc 键。
 * 支持左右切换（按钮 / ← → 键），并锁定背景滚动。
 */
export default function Lightbox({
  items,
  index,
  onClose,
  onIndexChange,
}: LightboxProps) {
  const open = index !== null && index >= 0 && index < items.length;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const go = useCallback(
    (delta: number) => {
      if (index === null || !onIndexChange) return;
      if (items.length === 0) return;
      const next = (index + delta + items.length) % items.length;
      onIndexChange(next);
    },
    [index, items.length, onIndexChange],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, go]);

  if (!open || index === null) return null;

  const item = items[index];

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片放大查看"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(12,14,18,.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '64px 72px',
        animation: 'tm-fade-in var(--tm-dur) var(--tm-ease-out) both',
      }}
    >
      {/* 右上角关闭（主关闭入口） */}
      <button
        type="button"
        aria-label="关闭图片查看"
        title="关闭（Esc）"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="tm-press"
        style={{
          position: 'absolute',
          top: 20,
          right: 24,
          width: 48,
          height: 48,
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,.35)',
          background: 'rgba(255,255,255,.16)',
          color: '#fff',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          backdropFilter: 'blur(4px)',
        }}
      >
        <CloseOutlined />
      </button>

      {/* 左上角计数 */}
      <div
        style={{
          position: 'absolute',
          top: 26,
          left: 26,
          color: 'rgba(255,255,255,.85)',
          fontSize: 13.5,
          letterSpacing: '.5px',
        }}
      >
        {index + 1} / {items.length}
      </div>

      {/* 上一张 */}
      {items.length > 1 && (
        <button
          type="button"
          aria-label="上一张"
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
          className="tm-press"
          style={navStyle('left')}
        >
          <LeftOutlined style={{ fontSize: 18 }} />
        </button>
      )}

      {/* 图片本体：阻止冒泡，避免点图片就关闭 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <img
          src={item.src}
          alt={item.caption || ''}
          style={{
            maxWidth: '100%',
            maxHeight: 'calc(100vh - 190px)',
            objectFit: 'contain',
            borderRadius: 10,
            background: '#fff',
            display: 'block',
          }}
        />
        {(item.caption || item.credit) && (
          <div
            style={{
              color: 'rgba(255,255,255,.92)',
              fontSize: 13.5,
              textAlign: 'center',
              maxWidth: 760,
              lineHeight: 1.6,
            }}
          >
            {item.caption}
            {item.credit && <span style={{ opacity: 0.65 }}> · {item.credit}</span>}
          </div>
        )}
      </div>

      {/* 下一张 */}
      {items.length > 1 && (
        <button
          type="button"
          aria-label="下一张"
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
          className="tm-press"
          style={navStyle('right')}
        >
          <RightOutlined style={{ fontSize: 18 }} />
        </button>
      )}

      {/* 底部：关闭按钮 + 操作提示 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          bottom: 22,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <span style={{ color: 'rgba(255,255,255,.55)', fontSize: 12.5 }}>
          <ZoomInOutlined style={{ marginRight: 6 }} />
          ← → 切换 · Esc 或点击空白处关闭
        </span>
        <button
          type="button"
          onClick={onClose}
          className="tm-press"
          style={{
            border: '1px solid rgba(255,255,255,.4)',
            background: 'rgba(255,255,255,.16)',
            color: '#fff',
            borderRadius: 999,
            padding: '6px 20px',
            fontSize: 13.5,
            cursor: 'pointer',
            fontFamily: 'inherit',
            backdropFilter: 'blur(4px)',
          }}
        >
          关闭
        </button>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

function navStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    [side]: 24,
    width: 46,
    height: 46,
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,.32)',
    background: 'rgba(255,255,255,.14)',
    color: '#fff',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(4px)',
  } as React.CSSProperties;
}
