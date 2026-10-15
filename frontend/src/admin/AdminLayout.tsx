import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Avatar, Button, Drawer, Layout, Menu, Tag, Tooltip, message } from 'antd';
import type { MenuProps } from 'antd';
import {
  AuditOutlined,
  BookOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuOutlined,
  TagsOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useIsMobile } from '../shared/useIsMobile';

const { Header, Sider, Content } = Layout;

interface NavItem {
  key: string;
  label: string;
  icon: ReactElement;
}

const NAV_ITEMS: NavItem[] = [
  { key: '/admin', label: '仪表盘', icon: <DashboardOutlined /> },
  { key: '/admin/games', label: '桌游管理', icon: <DatabaseOutlined /> },
  { key: '/admin/users', label: '用户管理', icon: <TeamOutlined /> },
  { key: '/admin/tags', label: '标签管理', icon: <TagsOutlined /> },
  { key: '/admin/moderation', label: '内容审核', icon: <AuditOutlined /> },
  { key: '/admin/rule-docs', label: '规则文档', icon: <BookOutlined /> },
];

/** antd Menu 需要的 items 结构，由上面的导航表派生，避免两处维护 */
const MENU_ITEMS: MenuProps['items'] = NAV_ITEMS.map(({ key, label, icon }) => ({
  key,
  label,
  icon,
}));

const ROOT_KEY = '/admin';

/**
 * 由路径解析当前菜单项。
 * 注意：不能直接用 startsWith('/admin')，因为它是所有后台路径的公共前缀，
 * 会让「仪表盘」恒为选中项；这里按最长匹配挑选具体子菜单。
 */
function resolveNavKey(pathname: string): string {
  const exact = NAV_ITEMS.find((item) => item.key === pathname);
  if (exact) return exact.key;

  let matched = ROOT_KEY;
  let matchedLength = 0;
  for (const item of NAV_ITEMS) {
    if (item.key === ROOT_KEY) continue;
    const hit = pathname === item.key || pathname.startsWith(`${item.key}/`);
    if (hit && item.key.length > matchedLength) {
      matched = item.key;
      matchedLength = item.key.length;
    }
  }
  return matched;
}

/** 侧边栏 + 抽屉共用的品牌区 */
function BrandBlock({ collapsed }: { collapsed?: boolean }) {
  return (
    <div
      style={{
        height: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: collapsed ? '0 22px' : '0 20px',
        borderBottom: '1px solid var(--tm-border)',
        overflow: 'hidden',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 'var(--tm-radius-md)',
          background: 'linear-gradient(135deg, var(--tm-brand-light), var(--tm-action))',
          color: '#fff',
          fontWeight: 700,
          fontSize: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        T
      </span>
      {!collapsed && (
        <span
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--tm-text-primary)',
            whiteSpace: 'nowrap',
          }}
        >
          TableMind
          <span style={{ color: 'var(--tm-link)', fontSize: 13, marginLeft: 6 }}>管理端</span>
        </span>
      )}
    </div>
  );
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { user, logout } = useAuthStore();

  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 路由变化后自动收起移动端抽屉
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const activeKey = resolveNavKey(location.pathname);
  const activeItem = NAV_ITEMS.find((item) => item.key === activeKey);

  const handleLogout = () => {
    logout();
    message.success('已退出登录');
    navigate('/admin/login', { replace: true });
  };

  const menu = (
    <Menu
      mode="inline"
      theme="light"
      items={MENU_ITEMS}
      selectedKeys={[activeKey]}
      onClick={({ key }) => navigate(key)}
      style={{ borderInlineEnd: 'none', padding: '10px 8px' }}
    />
  );

  const navButton = (collapsedView?: boolean) => (
    <Tooltip title={collapsedView ? '展开侧边栏' : '收起侧边栏'}>
      <Button
        type="text"
        aria-label="切换侧边栏"
        icon={<MenuOutlined />}
        onClick={() => setCollapsed((v) => !v)}
        style={{ color: 'var(--tm-text-secondary)' }}
      />
    </Tooltip>
  );

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--tm-surface-page)' }} hasSider={!isMobile}>
      {!isMobile && (
        <Sider
          width={220}
          theme="light"
          collapsible
          collapsed={collapsed}
          onCollapse={(value) => setCollapsed(value)}
          trigger={null}
          style={{
            borderRight: '1px solid var(--tm-border)',
            background: 'var(--tm-surface-card)',
          }}
        >
          <BrandBlock collapsed={collapsed} />
          {menu}
        </Sider>
      )}

      {isMobile && (
        <Drawer
          placement="left"
          width={236}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          closable={false}
          styles={{ body: { padding: 0, background: 'var(--tm-surface-card)' } }}
        >
          <BrandBlock />
          {menu}
        </Drawer>
      )}

      <Layout style={{ background: 'var(--tm-surface-page)', minWidth: 0 }}>
        <Header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 20,
            height: 60,
            lineHeight: 1,
            padding: isMobile ? '0 14px' : '0 22px',
            background: 'var(--tm-surface-card)',
            borderBottom: '1px solid var(--tm-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          {isMobile ? (
            <Button
              type="text"
              aria-label="打开导航"
              icon={<MenuOutlined />}
              onClick={() => setDrawerOpen(true)}
              style={{ color: 'var(--tm-text-secondary)' }}
            />
          ) : (
            navButton(collapsed)
          )}

          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--tm-text-primary)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {activeItem?.label ?? '管理端'}
          </span>

          {/* 当前管理员信息 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Avatar
              size={30}
              src={user?.avatar || undefined}
              style={{
                background: 'var(--tm-tint)',
                color: 'var(--tm-action)',
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {(user?.username ?? 'A').charAt(0).toUpperCase()}
            </Avatar>
            {!isMobile && (
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--tm-text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {user?.username ?? '未登录'}
              </span>
            )}
            <Tag
              color={user?.role === 'admin' ? 'volcano' : 'default'}
              style={{ marginInlineEnd: 0, borderRadius: 'var(--tm-radius-sm)', flexShrink: 0 }}
            >
              {user?.role === 'admin' ? '管理员' : user?.role ?? '未知'}
            </Tag>
          </div>

          <Tooltip title="返回前台">
            <Button
              type="text"
              icon={<HomeOutlined />}
              aria-label="返回前台"
              onClick={() => navigate('/')}
              style={{ color: 'var(--tm-text-secondary)' }}
            >
              {isMobile ? undefined : '前台'}
            </Button>
          </Tooltip>

          <Tooltip title="退出登录">
            <Button
              type="text"
              danger
              icon={<LogoutOutlined />}
              aria-label="退出登录"
              onClick={handleLogout}
            />
          </Tooltip>
        </Header>

        <Content style={{ padding: isMobile ? 14 : 22, minWidth: 0 }}>
          {/* key 变化触发页面入场动画，同时天然重置上一页的内部状态 */}
          <div key={location.pathname} className="tm-page-enter" style={{ minWidth: 0 }}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
