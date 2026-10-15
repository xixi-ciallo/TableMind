import { useLocation, useNavigate } from 'react-router-dom';
import {
  HomeOutlined,
  AppstoreOutlined,
  CrownOutlined,
  DashboardOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/auth';

const baseTabs = [
  { key: '/', label: '首页', icon: HomeOutlined },
  { key: '/games', label: '桌游库', icon: AppstoreOutlined },
  { key: '/rankings', label: '排行', icon: CrownOutlined },
  { key: '/ai', label: 'AI 助手', icon: RobotOutlined },
  { key: '/profile', label: '我的', icon: UserOutlined },
];

/** 移动端底部标签栏：固定底部，暖色高亮选中项 */
export default function MobileTabBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, user } = useAuthStore();

  const selected = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;

  /** 管理员额外显示「管理端」入口，方便从移动端用户页一键返回后台 */
  const tabs = user?.role === 'admin' ? [...baseTabs, { key: '/admin', label: '管理端', icon: DashboardOutlined }] : baseTabs;

  return (
    <nav
      aria-label="底部导航"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'rgba(255,255,255,.94)',
        backdropFilter: 'saturate(180%) blur(14px)',
        WebkitBackdropFilter: 'saturate(180%) blur(14px)',
        borderTop: '1px solid var(--tm-border)',
        display: 'flex',
        zIndex: 100,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {tabs.map(({ key, label, icon: Icon }) => {
        const active = selected === key;
        return (
          <button
            key={key}
            aria-current={active ? 'page' : undefined}
            className="tm-press"
            onClick={() => navigate(key === '/profile' && !token ? '/login' : key)}
            style={{
              flex: 1,
              height: 58,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              color: active ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            <Icon style={{ fontSize: 21 }} />
            <span style={{ fontSize: 11, fontWeight: active ? 700 : 400 }}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
