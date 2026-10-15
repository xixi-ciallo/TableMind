import { createBrowserRouter, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import { useAuthStore } from './stores/auth';

import UserLayout from './user/UserLayout';

// 路由级懒加载：按页面拆包，首屏只加载当前页，切换时再按需拉取
const HomePage = lazy(() => import('./user/pages/HomePage'));
const GameListPage = lazy(() => import('./user/pages/GameListPage'));
const GameDetailPage = lazy(() => import('./user/pages/GameDetailPage'));
const RankingsPage = lazy(() => import('./user/pages/RankingsPage'));
const CommunityPage = lazy(() => import('./user/pages/CommunityPage'));
const PostDetailPage = lazy(() => import('./user/pages/PostDetailPage'));
const PostComposePage = lazy(() => import('./user/pages/PostComposePage'));
const ProfilePage = lazy(() => import('./user/pages/ProfilePage'));
const AiAssistantPage = lazy(() => import('./user/pages/AiAssistantPage'));
const LoginPage = lazy(() => import('./user/pages/LoginPage'));
const RegisterPage = lazy(() => import('./user/pages/RegisterPage'));

const AdminLayout = lazy(() => import('./admin/AdminLayout'));
const AdminLoginPage = lazy(() => import('./admin/pages/AdminLoginPage'));
const DashboardPage = lazy(() => import('./admin/pages/DashboardPage'));
const GameManagePage = lazy(() => import('./admin/pages/GameManagePage'));
const RuleDocsPage = lazy(() => import('./admin/pages/RuleDocsPage'));
const UserManagePage = lazy(() => import('./admin/pages/UserManagePage'));
const ModerationPage = lazy(() => import('./admin/pages/ModerationPage'));
const TagManagePage = lazy(() => import('./admin/pages/TagManagePage'));

/** 页面加载占位：与最终版式接近的骨架屏，避免切换时白屏跳动 */
function PageSkeleton() {
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', width: '100%', padding: '8px 0' }}>
      <div className="tm-skeleton" style={{ height: 150, borderRadius: 20, marginBottom: 18 }} />
      <div className="tm-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))',
          gap: 16,
        }}
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i}>
            <div className="tm-skeleton" style={{ aspectRatio: '4 / 5', borderRadius: 14 }} />
            <div className="tm-skeleton" style={{ height: 15, width: '72%', marginTop: 10 }} />
            <div className="tm-skeleton" style={{ height: 12, width: '48%', marginTop: 7 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function withSuspense(node: ReactElement) {
  return <Suspense fallback={<PageSkeleton />}>{node}</Suspense>;
}

// 管理端守卫：未登录或非管理员跳转到管理端登录页
function AdminGuard({ children }: { children: ReactElement }) {
  const { token, user } = useAuthStore();
  if (!token || user?.role !== 'admin') {
    return <Navigate to="/admin/login" replace />;
  }
  return children;
}

export const router = createBrowserRouter([
  // 用户端
  {
    path: '/',
    element: <UserLayout />,
    children: [
      { index: true, element: withSuspense(<HomePage />) },
      { path: 'games', element: withSuspense(<GameListPage />) },
      { path: 'games/:id', element: withSuspense(<GameDetailPage />) },
      { path: 'rankings', element: withSuspense(<RankingsPage />) },
      { path: 'community', element: withSuspense(<CommunityPage />) },
      { path: 'community/new', element: withSuspense(<PostComposePage />) },
      { path: 'community/:id', element: withSuspense(<PostDetailPage />) },
      { path: 'profile', element: withSuspense(<ProfilePage />) },
      { path: 'ai', element: withSuspense(<AiAssistantPage />) },
    ],
  },
  // 登录 / 注册（独立全屏页，不带导航栏）
  { path: '/login', element: withSuspense(<LoginPage />) },
  { path: '/register', element: withSuspense(<RegisterPage />) },
  // 管理端登录（独立页面，不走 AdminLayout，否则守卫会死循环）
  { path: '/admin/login', element: withSuspense(<AdminLoginPage />) },
  // 管理端（需管理员角色）
  {
    path: '/admin',
    element: (
      <AdminGuard>
        {withSuspense(<AdminLayout />)}
      </AdminGuard>
    ),
    children: [
      { index: true, element: withSuspense(<DashboardPage />) },
      { path: 'games', element: withSuspense(<GameManagePage />) },
      { path: 'rule-docs', element: withSuspense(<RuleDocsPage />) },
      { path: 'users', element: withSuspense(<UserManagePage />) },
      { path: 'moderation', element: withSuspense(<ModerationPage />) },
      { path: 'tags', element: withSuspense(<TagManagePage />) },
    ],
  },
]);
