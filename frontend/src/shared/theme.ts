import type { ThemeConfig } from 'antd';

/**
 * TableMind 全局主题（参考 TapTap 网页版的暖色主色与卡片化版式）
 *
 * 双主色策略：暖珊瑚色只做装饰，承载白色文字的色值全部经过对比度实测。
 * - 品牌珊瑚色 #ff6b45：高明度装饰色，用于渐变 / 图标 / 大面积色块，不承载白色文字
 * - 交互色 #d93d1a：按钮、选中态，白字对比度 4.53:1（WCAG AA 达标）
 * - 链接色 #c43715：白底 5.38:1（AA 达标）
 * - 信息蓝 #0e7fb8：次要信息标签，与暖色形成对比
 */
export const BRAND = '#ff6b45';
export const BRAND_LIGHT = '#ff8f6d';
export const ACTION = '#d93d1a';
export const ACTION_HOVER = '#c43715';
export const LINK = '#c43715';
export const RATING = '#d93d1a';
/** 浅暖底上的深色文字（用于标签） */
export const TEXT_ON_TINT = '#c43715';
export const INFO = '#0e7fb8';
export const TEXT_SECONDARY = '#6b7280';
export const TEXT_TERTIARY = '#9ca3af';

/* 兼容旧命名：语义已更新，保留别名避免遗漏的引用报错 */
/** @deprecated 请使用 BRAND */
export const BRAND_BLUE = BRAND;
/** @deprecated 请使用 ACTION */
export const ACTION_BLUE = ACTION;
/** @deprecated 请使用 LINK */
export const LINK_BLUE = LINK;
/** @deprecated 请使用 RATING */
export const RATING_ORANGE = RATING;
/** @deprecated 请使用 TEXT_ON_TINT */
export const TEXT_ORANGE = TEXT_ON_TINT;

export const taptapTheme: ThemeConfig = {
  token: {
    colorPrimary: ACTION,
    colorInfo: INFO,
    colorLink: LINK,
    colorBgLayout: '#f6f7f9',
    colorTextBase: '#1a1a1a',
    colorTextSecondary: TEXT_SECONDARY,
    colorBorderSecondary: '#eef0f3',
    borderRadius: 10,
    fontSize: 14,
    controlHeight: 36,
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
  },
  components: {
    Button: {
      borderRadius: 999,
      controlHeight: 36,
      fontWeight: 500,
      primaryShadow: '0 6px 18px rgba(217,61,26,.28)',
      defaultShadow: 'none',
    },
    Card: {
      borderRadiusLG: 16,
      paddingLG: 20,
    },
    Input: {
      borderRadius: 12,
      controlHeight: 42,
    },
    Tag: {
      borderRadiusSM: 8,
    },
    Menu: {
      itemBorderRadius: 12,
      itemHeight: 42,
      itemSelectedColor: ACTION,
      itemSelectedBg: '#fff2ee',
    },
    Tabs: {
      itemSelectedColor: ACTION,
      inkBarColor: ACTION,
      titleFontSize: 15,
    },
    Segmented: {
      itemSelectedBg: '#fff2ee',
      itemSelectedColor: ACTION,
      borderRadius: 10,
    },
    Pagination: {
      itemActiveBg: ACTION,
    },
    Modal: {
      borderRadiusLG: 16,
    },
    Empty: {
      colorTextDescription: TEXT_SECONDARY,
    },
  },
};

/** 页面容器：居中 + 最大宽度 */
export const pageContainerStyle: React.CSSProperties = {
  maxWidth: 1180,
  margin: '0 auto',
  width: '100%',
};

/** 卡片基础样式：白底 + 圆角 + 轻阴影（配合 index.css 的 .tm-card 使用） */
export const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 2px 8px rgba(17,24,39,.06)',
};

/** @deprecated 直接用 className="tm-card" 获得统一手感 */
export const cardHoverStyle: React.CSSProperties = {
  transition: 'box-shadow .22s cubic-bezier(.22,.61,.36,1), transform .22s cubic-bezier(.22,.61,.36,1)',
  cursor: 'pointer',
};
