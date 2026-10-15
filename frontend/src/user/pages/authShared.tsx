import type { CSSProperties, ReactNode } from 'react';
import BackButton from '../../shared/BackButton';

/** 登录 / 注册页共享布局：左侧品牌渐变面板 + 右侧表单区 */

export const authShellStyle: CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  background: '#fff',
};

export function AuthSide({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      style={{
        width: 420,
        flexShrink: 0,
        background: 'linear-gradient(160deg, #ff8f6d 0%, #e8502a 55%, #c43715 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 48,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          right: -70,
          top: -70,
          width: 260,
          height: 260,
          borderRadius: '50%',
          background: 'rgba(255,255,255,.14)',
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: -60,
          bottom: -90,
          width: 220,
          height: 220,
          borderRadius: '50%',
          background: 'rgba(255,255,255,.1)',
        }}
      />
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 1, marginBottom: 14 }}>TableMind</div>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>{title}</div>
        <div style={{ color: 'rgba(255,255,255,.88)', fontSize: 14, lineHeight: 1.8 }}>{subtitle}</div>
      </div>
    </div>
  );
}

/**
 * 认证页外壳：左上角固定「返回」按钮（窄屏时回到上一页 / 首页）。
 * 用户从任何入口进入登录注册都有一条明确的退路。
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div style={authShellStyle}>
      <AuthSide
        title="发现你的下一款桌游"
        subtitle="收录真实桌游资料 · 逐条标注来源 · 教学视频与 AI 规则助手"
      />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative' }}>
        <BackButton
          label="返回首页"
          fallback="/"
          variant="solid"
          style={{ position: 'absolute', left: 20, top: 20 }}
        />
        {children}
      </div>
    </div>
  );
}
