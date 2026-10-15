/** 管理端页面统一容器：白卡片 + 标题 + 描述 + 右上角操作区 */
import type { ReactNode } from 'react';
import { useIsMobile } from '../shared/useIsMobile';

interface AdminPageCardProps {
  title: string;
  description?: string;
  /** 标题图标 */
  icon?: ReactNode;
  /** 右上角操作区（按钮等） */
  extra?: ReactNode;
  children: ReactNode;
}

export default function AdminPageCard({
  title,
  description,
  icon,
  extra,
  children,
}: AdminPageCardProps) {
  const isMobile = useIsMobile();

  return (
    <div
      style={{
        background: 'var(--tm-surface-card)',
        border: '1px solid var(--tm-border)',
        borderRadius: 'var(--tm-radius-lg)',
        boxShadow: 'var(--tm-shadow-card)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: isMobile ? '16px 16px 0' : '20px 24px 0',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        {icon && (
          <span
            aria-hidden
            style={{
              width: 38,
              height: 38,
              borderRadius: 'var(--tm-radius-md)',
              background: 'var(--tm-tint)',
              color: 'var(--tm-action)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              flexShrink: 0,
            }}
          >
            {icon}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 180 }}>
          <h2
            style={{
              margin: 0,
              fontSize: isMobile ? 17 : 19,
              fontWeight: 700,
              color: 'var(--tm-text-primary)',
              lineHeight: 1.35,
            }}
          >
            {title}
          </h2>
          {description && (
            <p
              style={{
                margin: '5px 0 0',
                fontSize: 13,
                lineHeight: 1.7,
                color: 'var(--tm-text-secondary)',
              }}
            >
              {description}
            </p>
          )}
        </div>
        {extra && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {extra}
          </div>
        )}
      </div>
      <div style={{ padding: isMobile ? '16px' : '18px 24px 22px' }}>{children}</div>
    </div>
  );
}
