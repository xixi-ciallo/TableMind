import type { CSSProperties } from 'react';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';

interface BackButtonProps {
  /** 按钮文案 */
  label?: string;
  /** 没有可返回的历史记录时的兜底路径 */
  fallback?: string;
  /** 视觉风格：ghost（页面内文字型） | solid（独立圆形按钮） */
  variant?: 'ghost' | 'solid';
  style?: CSSProperties;
}

/**
 * 通用返回按钮。
 * 优先回退到浏览器的上一条记录；如果当前是直接打开的首页入口（没有可返回的历史），
 * 则跳到 fallback，避免出现「点了没反应」。
 */
export default function BackButton({
  label = '返回',
  fallback = '/',
  variant = 'ghost',
  style,
}: BackButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const goBack = () => {
    // location.key === 'default' 表示这是当前会话的第一个路由，回退会离开站点
    if (location.key === 'default') {
      navigate(fallback);
    } else {
      navigate(-1);
    }
  };

  const base: CSSProperties =
    variant === 'solid'
      ? {
          height: 38,
          minWidth: 38,
          padding: '0 15px 0 13px',
          borderRadius: 999,
          border: '1px solid var(--tm-border-strong)',
          background: 'rgba(255,255,255,.94)',
          color: 'var(--tm-text-primary)',
          boxShadow: '0 2px 8px rgba(17,24,39,.08)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          fontSize: 14,
          fontWeight: 500,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }
      : {
          border: 'none',
          background: 'transparent',
          color: 'var(--tm-text-secondary)',
          fontSize: 13.5,
          cursor: 'pointer',
          padding: '6px 10px 6px 0',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'inherit',
        };

  return (
    <button
      type="button"
      onClick={goBack}
      className="tm-press"
      aria-label={label}
      style={{ ...base, ...style }}
    >
      <ArrowLeftOutlined style={{ fontSize: variant === 'solid' ? 14 : 11 }} />
      <span>{label}</span>
    </button>
  );
}
