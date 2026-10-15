import { Avatar, Button, Divider, Modal, Popover, Space } from 'antd';import {
  ArrowUpOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CrownOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DownOutlined,
  FileTextOutlined,
  FireFilled,
  HeartOutlined,
  HistoryOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  StarOutlined,
  TeamOutlined,
  UpOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useIsMobile } from '../shared/useIsMobile';
import { allCategories, allMechanics, gameLibrary } from '../shared/gameLibrary';
import client from '../shared/api/client';
import {
  readRecentEntries,
  readRecentIds,
  writeRecentEntries,
} from '../shared/recentHistory';
import MobileTabBar from './MobileTabBar';

/** 本机搜索历史的存储键 */
const HISTORY_KEY = 'tablemind_search_history';
/** 侧边栏收起状态的存储键 */
const SIDEBAR_KEY = 'tablemind_sidebar_collapsed';

/* ── 左侧导航（与 TapTap 桌面端首页一致的窄边栏） ── */
const navItems = [
  { key: '/', label: '首页', icon: <HomeOutlined /> },
  { key: '/games', label: '桌游库', icon: <MenuOutlined /> },
  { key: '/rankings', label: '排行榜', icon: <CrownOutlined /> },
  { key: '/community', label: '社区', icon: <TeamOutlined /> },
  { key: '/ai', label: 'AI 助手', icon: <RobotOutlined /> },
];

/* ── 搜索面板：历史搜索 / 搜索发现 / 热搜 / 高分榜 ── */

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

function pushHistory(word: string) {
  const next = [word, ...readHistory().filter((x) => x !== word)].slice(0, 12);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下写入失败可忽略 */
  }
}

/** 搜索发现：全部取自库内真实标签，换一换就是重新洗牌 */
function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDiscover(): string[] {
  return shuffle([...new Set([...allCategories, ...allMechanics])]).slice(0, 18);
}

/** 侧边栏「最近浏览」：只读本机真实访问记录，没有就是没有，不拿库内游戏顶替 */
function readRecent(): typeof gameLibrary {
  const ids = readRecentIds();
  const picked = ids
    .map((id) => gameLibrary.find((g) => g.id === id))
    .filter((g): g is (typeof gameLibrary)[number] => !!g);
  /** 只展示最新的 6 条 */
  return picked.slice(0, 6);
}

/** 手机号脱敏展示：138****1234 */
function maskPhone(phone?: string | null): string {
  if (!phone || phone.length < 7) return phone ?? '—';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 顶栏头像 hover 弹层：头部信息 + 快捷入口 + 功能项 + 退出登录 */
function ProfilePopoverContent({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  const quickEntries = [
    { icon: <HeartOutlined />, label: '桌游收藏', path: '/profile?tab=collections&sub=games' },
    { icon: <StarOutlined />, label: '帖子收藏', path: '/profile?tab=collections&sub=posts' },
    { icon: <HistoryOutlined />, label: '浏览历史', path: '/profile?tab=history' },
    { icon: <FileTextOutlined />, label: '我的帖子', path: '/profile?tab=posts' },
  ];
  const menuRows = [
    { icon: <CrownOutlined />, label: '我的评测', path: '/profile?tab=reviews' },
    { icon: <MessageOutlined />, label: 'AI 助手', path: '/ai' },
    { icon: <SettingOutlined />, label: '修改密码', path: '/profile?pwd=1' },
  ];

  return (
    <div style={{ width: 288 }}>
      {/* 头部：头像 + 名称 + 手机号 + 个人中心入口 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 12px' }}>
        {user.avatar ? (
          <img
            src={user.avatar}
            alt=""
            style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
          />
        ) : (
          <Avatar
            size={52}
            style={{
              background: 'linear-gradient(135deg, #ff8f6d, #d93d1a)',
              fontSize: 22,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {user.username.charAt(0).toUpperCase()}
          </Avatar>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: 16,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {user.username}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)', marginTop: 2 }}>
            ID: {maskPhone(user.phone)}
          </div>
        </div>
        <button
          onClick={() => navigate('/profile')}
          className="tm-press"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--tm-text-secondary)',
            fontSize: 12.5,
            cursor: 'pointer',
            padding: '4px 2px',
            fontFamily: 'inherit',
            flexShrink: 0,
          }}
        >
          个人中心 ›
        </button>
      </div>
      <Divider style={{ margin: 0 }} />
      {/* 快捷入口 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', padding: '14px 8px 10px' }}>
        {quickEntries.map((e) => (
          <button
            key={e.label}
            onClick={() => navigate(e.path)}
            className="tm-press tm-pop-item"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '6px 0',
              borderRadius: 10,
              fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 20, color: '#4b5563' }}>{e.icon}</span>
            <span style={{ fontSize: 12, color: '#374151' }}>{e.label}</span>
          </button>
        ))}
      </div>
      <Divider style={{ margin: 0 }} />
      {/* 功能项 */}
      <div style={{ padding: '6px 0' }}>
        {menuRows.map((m) => (
          <button
            key={m.label}
            onClick={() => navigate(m.path)}
            className="tm-press tm-pop-item"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '11px 16px',
              fontSize: 14,
              color: '#374151',
              fontFamily: 'inherit',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 16, color: '#6b7280' }}>{m.icon}</span>
            {m.label}
          </button>
        ))}
      </div>
      <Divider style={{ margin: 0 }} />
      <div style={{ padding: '6px 0 8px' }}>
        <button
          onClick={onLogout}
          className="tm-press tm-pop-item"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '11px 16px',
            fontSize: 14,
            color: 'var(--tm-action)',
            fontFamily: 'inherit',
            textAlign: 'left',
          }}
        >
          <LogoutOutlined style={{ fontSize: 16 }} />
          退出登录
        </button>
      </div>
    </div>
  );
}

export default function UserLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, user, logout } = useAuthStore();
  const isMobile = useIsMobile();
  /** 未登录不产生、也不展示任何本机记录（最近浏览 / 搜索历史） */
  const isLoggedIn = Boolean(token);

  /** 侧边栏收起 / 展开：桌面端可用，状态记在本机 */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* 隐私模式忽略 */
      }
      return next;
    });
  };

  const [kw, setKw] = useState('');
  /** 最近浏览的手工改版本号：置顶 / 删除后同步刷新侧栏 */
  const [recentVer, setRecentVer] = useState(0);
  /** 最近浏览列表是否展开全部（TapTap 式「显示更多」） */
  const [showAllRecents, setShowAllRecents] = useState(false);

  /* ── 搜索面板状态 ── */
  /** 顶部搜索框左侧的范围：搜桌游还是搜帖子（默认桌游，保持原有行为） */
  const [searchKind, setSearchKind] = useState<'game' | 'post'>('game');
  const [searchOpen, setSearchOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(readHistory);
  const [discover, setDiscover] = useState<string[]>(pickDiscover);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  /** 点面板外的任意位置就收起面板；顺带把本机历史重新读进来 */
  useEffect(() => {
    if (!searchOpen) return;
    setHistory(isLoggedIn ? readHistory() : []);
    const onDown = (e: PointerEvent) => {
      const box = searchBoxRef.current;
      if (box && !box.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [searchOpen, isLoggedIn]);

  /** 路由一变就收起面板 */
  useEffect(() => {
    setSearchOpen(false);
  }, [location.pathname]);

  /** 搜索榜 / 高分榜：每次打开面板都重新拉一次系统数据，榜单跟着真实评分走 */
  type Row = { id: number; name: string; avg_rating: number; rating_count: number; year_published: number | null };
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (!searchOpen) return;
    let alive = true;
    client
      .get<Row[]>('/games', { params: { page_size: 100 } })
      .then(({ data }) => {
        if (alive && Array.isArray(data)) setRows(data);
      })
      .catch(() => {
        /* 接口不可用时面板上的榜单留空，不补假数据 */
      });
    return () => {
      alive = false;
    };
  }, [searchOpen]);

  /** 两榜各取前 10 */
  const RANK_SIZE = 10;
  const hotList = useMemo(
    () => [...rows].sort((a, b) => (b.rating_count - a.rating_count) || (b.avg_rating - a.avg_rating)).slice(0, RANK_SIZE),
    [rows],
  );
  const topList = useMemo(
    () => [...rows].sort((a, b) => (b.avg_rating - a.avg_rating) || (b.rating_count - a.rating_count)).slice(0, RANK_SIZE),
    [rows],
  );

  const goSearch = (word: string) => {
    const q = word.trim();
    if (q && isLoggedIn) pushHistory(q);
    setHistory(isLoggedIn ? readHistory() : []);
    setSearchOpen(false);
    if (!q) {
      navigate(searchKind === 'post' ? '/community' : '/games');
      return;
    }
    // 真实搜索记录入库，热门搜索榜据此更新
    client.post('/search/log', { kind: searchKind, term: q }).catch(() => {});
    // 通知社区页刷新「热门搜索」
    window.dispatchEvent(new CustomEvent('tablemind:search', { detail: { term: q, kind: searchKind } }));
    navigate(
      searchKind === 'post'
        ? `/community?q=${encodeURIComponent(q)}`
        : `/games?q=${encodeURIComponent(q)}`,
    );
  };
  const submitSearch = (text: string) => goSearch(text);

  const selectedKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;
  /** AI 助手页：自带侧栏且通栏铺满，底部不要再叠一层站点页脚 */
  const isAi = location.pathname === '/ai';
  /** 游戏详情页（/games/:id）与 AI 助手页（/ai）自带侧栏，属于沉浸式视图：不显示全局左边栏、内容通栏 */
  const immersive = /^\/games\/.+/.test(location.pathname) || isAi;
  /** 随路由刷新：进入详情页时会写入本机浏览记录 */
  const recents = useMemo(
    () => (isMobile || !isLoggedIn ? [] : readRecent()),
    [isMobile, isLoggedIn, location.pathname, recentVer],
  );

  /* ── 「管理列表」：对本机浏览记录做置顶 / 删除 ── */
  const [manageOpen, setManageOpen] = useState(false);
  const [manageList, setManageList] = useState<typeof gameLibrary>([]);

  /** 打开面板时以本机真实记录为准（可能为空白态）；同时记住时间戳，删除后不丢 */
  const [manageTs, setManageTs] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!manageOpen) return;
    const entries = readRecentEntries();
    setManageTs(Object.fromEntries(entries.map((e) => [e.id, e.ts])));
    const list = isLoggedIn
      ? entries.map((e) => gameLibrary.find((g) => g.id === e.id)).filter((g): g is (typeof gameLibrary)[number] => !!g)
      : [];
    setManageList(list);
  }, [manageOpen, isLoggedIn]);

  const persistManage = (next: typeof gameLibrary) => {
    setManageList(next);
    writeRecentEntries(next.map((g) => ({ id: g.id, ts: manageTs[g.id] ?? 0 })));
    setRecentVer((v) => v + 1);
  };

  const moveToTop = (id: number) => {
    const target = manageList.find((g) => g.id === id);
    if (!target) return;
    persistManage([target, ...manageList.filter((g) => g.id !== id)]);
  };

  const removeOne = (id: number) => {
    persistManage(manageList.filter((g) => g.id !== id));
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  // ── 移动端：底部 TabBar ──
  if (isMobile) {
    return (
      <div style={{ minHeight: '100dvh', background: 'var(--tm-surface-page)' }}>
        <main style={{ paddingBottom: 64 }}>
          <Outlet />
        </main>
        <MobileTabBar />
      </div>
    );
  }

  /* ── 桌面端：TapTap 式顶栏 + 左侧窄边栏 ── */
  return (
    <div
      style={{
        minHeight: '100vh',
        /* 与 TapTap 桌面端一致：整页白底，卡片靠圆角 + 阴影分层 */
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 顶栏：logo + 中央搜索 + 右侧操作区 */}
      <header
        style={{
          background: '#fff',
          borderBottom: '1px solid var(--tm-border)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <div
          style={{
            /* TapTap 式：顶栏通栏，汉堡键 + 站名靠最左侧 */
            padding: '0 22px',
            height: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          {/* 汉堡键：在站名左侧，控制侧边栏收起 / 展开 */}
          <button
            onClick={toggleSidebar}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-expanded={!collapsed}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            className="tm-press"
            style={{
              border: 'none',
              background: 'transparent',
              color: '#6b7280',
              width: 32,
              height: 32,
              borderRadius: 9,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              flexShrink: 0,
              marginLeft: -4,
            }}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>

          <Link
            to="/"
            aria-label="TableMind 首页"
            className="tm-press"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              textDecoration: 'none',
              flexShrink: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 32,
                height: 32,
                borderRadius: 11,
                background: 'linear-gradient(135deg, #ff9a6d, #d93d1a)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 17,
                fontWeight: 800,
                boxShadow: '0 4px 12px rgba(217,61,26,.28)',
              }}
            >
              T
            </span>
            <span
              style={{
                fontSize: 21,
                fontWeight: 800,
                letterSpacing: 0.2,
                color: 'var(--tm-text-primary)',
              }}
            >
              TableMind
            </span>
          </Link>

          {/* 居中的搜索区：左侧「桌游/帖子」范围选择（独立胶囊）+ 大搜索框 + 展开面板 */}
          <div
            style={{
              flex: 1,
              maxWidth: 700,
              margin: '0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            {/* 范围选择按钮：独立胶囊，自定义箭头，与搜索框同高同圆角 */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <select
                value={searchKind}
                onChange={(e) => setSearchKind(e.target.value as 'game' | 'post')}
                aria-label="搜索范围"
                className="tm-press"
                style={{
                  height: 42,
                  borderRadius: 999,
                  border: '1.5px solid transparent',
                  outline: 'none',
                  background: '#f3f4f6',
                  color: 'var(--tm-text-primary)',
                  fontFamily: 'inherit',
                  fontSize: 13.5,
                  fontWeight: 700,
                  padding: '0 34px 0 19px',
                  cursor: 'pointer',
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  boxShadow: '0 1px 3px rgba(15,23,42,.04)',
                  transition: 'background .18s var(--tm-ease-out), box-shadow .18s var(--tm-ease-out)',
                }}
              >
                <option value="game">桌游</option>
                <option value="post">帖子</option>
              </select>
              <DownOutlined
                aria-hidden
                style={{
                  position: 'absolute',
                  right: 15,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 11,
                  color: 'var(--tm-text-tertiary)',
                  pointerEvents: 'none',
                }}
              />
            </div>

            {/* 大搜索框 + 展开面板（保持原样式） */}
            <div ref={searchBoxRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <div
              onMouseDown={() => setSearchOpen(true)}
              style={{
                height: 42,
                border: `1.5px solid ${searchOpen ? '#00d6b9' : 'transparent'}`,
                background: searchOpen ? '#fff' : '#f3f4f6',
                borderRadius: 999,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '0 14px 0 17px',
                boxShadow: searchOpen ? '0 6px 20px rgba(0,180,160,.14)' : 'none',
                transition: 'border-color .18s var(--tm-ease-out), box-shadow .18s var(--tm-ease-out)',
              }}
            >
              <SearchOutlined
                style={{ color: searchOpen ? '#00b8a0' : 'var(--tm-text-tertiary)', fontSize: 15 }}
              />
              <input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitSearch(kw);
                }}
                placeholder={searchKind === 'post' ? '搜索帖子标题或正文' : '搜索桌游名称、英文名或标签'}
                aria-label="搜索桌游"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  color: 'var(--tm-text-primary)',
                }}
              />
              {kw && (
                <button
                  aria-label="清空输入"
                  onClick={() => setKw('')}
                  className="tm-press"
                  style={{
                    border: 'none',
                    background: '#e5e7eb',
                    color: '#6b7280',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <CloseOutlined style={{ fontSize: 10 }} />
                </button>
              )}
            </div>

            {/* 下拉面板 */}
            {searchOpen && (
              <div
                role="dialog"
                aria-label="搜索建议"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 'max(100%, 760px)',
                  minWidth: 620,
                  background: '#fff',
                  border: '1px solid var(--tm-border)',
                  borderRadius: 16,
                  boxShadow: '0 16px 44px rgba(15,23,42,.16)',
                  padding: '18px 20px 20px',
                  zIndex: 120,
                  maxHeight: '70vh',
                  overflowY: 'auto',
                }}
              >
                {/* 历史搜索 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: 'var(--tm-text-primary)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    <ClockCircleOutlined style={{ color: 'var(--tm-action)', fontSize: 14 }} />
                    历史搜索
                  </span>
                  {history.length ? (
                    <button
                      onClick={() => {
                        try {
                          localStorage.removeItem(HISTORY_KEY);
                        } catch {
                          /* 忽略 */
                        }
                        setHistory([]);
                      }}
                      className="tm-press"
                      style={{ ...textLinkBtn, color: 'var(--tm-text-tertiary)' }}
                    >
                      <DeleteOutlined style={{ fontSize: 12 }} />
                      清除
                    </button>
                  ) : null}
                </div>
                {history.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginBottom: 20 }}>
                    {history.map((w) => (
                      <span key={w} style={{ ...chipBase, cursor: 'pointer' }} onClick={() => goSearch(w)}>
                        {w}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--tm-text-tertiary)',
                      marginBottom: 20,
                      padding: '9px 13px',
                      background: '#fafafa',
                      borderRadius: 9,
                    }}
                  >
                    {isLoggedIn ? '还没有搜索记录，搜过的关键词会留在这里' : '登录后可保存搜索记录'}
                  </div>
                )}

                {/* 搜索发现 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: 'var(--tm-text-primary)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    搜索发现
                  </span>
                  <button
                    onClick={() => setDiscover(pickDiscover())}
                    className="tm-press"
                    style={{ ...textLinkBtn, color: '#00b8a0' }}
                  >
                    <ReloadOutlined style={{ fontSize: 12 }} />
                    换一换
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginBottom: 22 }}>
                  {discover.map((w) => (
                    <span key={w} style={{ ...chipBase, cursor: 'pointer' }} onClick={() => goSearch(w)}>
                      {w}
                    </span>
                  ))}
                </div>

                {/* 热搜 / 高分榜 两栏 */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 26,
                    borderTop: '1px solid var(--tm-border)',
                    paddingTop: 16,
                  }}
                >
                  <RankColumn
                    title="桌游热搜"
                    list={hotList}
                    suffix={(r) => (r.rating_count ? `${r.rating_count} 评` : '')}
                  />
                  <RankColumn
                    title="高分精选"
                    list={topList}
                    suffix={(r) => (r.year_published ? `${r.year_published}` : '')}
                  />
                </div>
              </div>
            )}
            </div>
          </div>

          <Space size={12} style={{ flexShrink: 0 }}>
            {user?.role === 'admin' && (
              <button
                onClick={() => navigate('/admin')}
                className="tm-press"
                aria-label="返回管理端"
                title="返回管理端"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  border: '1px solid var(--tm-border-strong)',
                  background: '#fff',
                  color: 'var(--tm-action)',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  padding: '0 12px',
                  height: 34,
                  borderRadius: 8,
                }}
              >
                <DashboardOutlined style={{ fontSize: 16 }} />
                管理端
              </button>
            )}
            <button
              onClick={() => navigate('/ai')}
              className="tm-press"
              aria-label="AI 助手"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                border: 'none',
                background: 'transparent',
                color: '#374151',
                fontSize: 14,
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '0 2px',
              }}
            >
              <RobotOutlined style={{ fontSize: 16 }} />
              Ai
            </button>

            {token && user ? (
              <Popover
                placement="bottomRight"
                trigger="hover"
                arrow={false}
                styles={{ body: { padding: 0 } }}
                content={<ProfilePopoverContent onLogout={handleLogout} />}
              >
                <span style={{ cursor: 'pointer', display: 'inline-flex' }} className="tm-press">
                  {user.avatar ? (
                    <img
                      src={user.avatar}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : (
                    <Avatar
                      size={32}
                      style={{
                        background: 'linear-gradient(135deg, #ff8f6d, #d93d1a)',
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {user.username.charAt(0).toUpperCase()}
                    </Avatar>
                  )}
                </span>
              </Popover>
            ) : (
              <Space size={8}>
                <Button onClick={() => navigate('/login')}>登录</Button>
                <Button type="primary" onClick={() => navigate('/register')}>
                  注册
                </Button>
              </Space>
            )}
          </Space>
        </div>
      </header>

      {/* ── 左侧边栏：固定在视口最左侧（TapTap 式），内容区整体让出宽度；游戏详情页不显示 ── */}
      {!immersive && (collapsed ? (
        <nav
          aria-label="主导航"
          style={{
            position: 'fixed',
            left: 0,
            top: 64,
            bottom: 0,
            width: 64,
            zIndex: 90,
            background: '#fff',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            padding: '10px 0 24px',
          }}
        >
          {navItems.map((item) => {
              const active = selectedKey === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => navigate(item.key)}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={`tm-press tm-nav-item${active ? ' tm-nav-active' : ''}`}
                  style={{
                    border: 'none',
                    color: active ? 'var(--tm-action)' : '#6b7280',
                    width: 44,
                    height: 42,
                    borderRadius: 11,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 17,
                  }}
                >
                  {item.icon}
                </button>
              );
            })}
            {/* 收起态也保留最近浏览的封面入口（对应 TapTap 图标栏里的游戏小图标） */}
            {recents.length > 0 && (
              <>
                <div style={{ width: 26, height: 1, background: 'var(--tm-border)', margin: '7px 0 3px' }} />
                {recents.slice(0, 3).map((g) => (
                  <button
                    key={g.id}
                    onClick={() => navigate(`/games/${g.slug}`)}
                    aria-label={g.name}
                    title={g.name}
                    className="tm-press tm-nav-item"
                    style={{
                      border: 'none',
                      width: 44,
                      height: 44,
                      borderRadius: 11,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    <img
                      src={g.cover_image}
                      alt=""
                      loading="lazy"
                      style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'cover', background: '#f2f3f5' }}
                    />
                  </button>
                ))}
              </>
            )}
          </nav>
        ) : (
        <aside
          aria-label="主导航"
          style={{
            /* TapTap 式：贴视口最左侧，无卡片边框与阴影 */
            position: 'fixed',
            left: 0,
            top: 64,
            bottom: 0,
            width: 264,
            zIndex: 90,
            background: '#fff',
            overflowY: 'auto',
            padding: '10px 12px 24px',
          }}
        >
          {/* 主导航组 */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {navItems.map((item) => {
              const active = selectedKey === item.key;
              return (
                <button
                  key={item.key}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate(item.key)}
                  className={`tm-press tm-nav-item${active ? ' tm-nav-active' : ''}`}
                  style={{
                    border: 'none',
                    color: active ? '#111827' : '#374151',
                    fontWeight: active ? 700 : 500,
                    fontSize: 15,
                    height: 44,
                    borderRadius: 10,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '0 12px',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      fontSize: 17,
                      display: 'inline-flex',
                      color: active ? 'var(--tm-action)' : '#6b7280',
                    }}
                  >
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div style={{ height: 1, background: 'var(--tm-border)', margin: '10px 12px' }} />

          {/* 最近浏览：对应 TapTap 侧栏的游戏快捷列表，默认 3 条 + 「显示更多」 */}
          <div
            style={{
              padding: '0 12px 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--tm-text-secondary)',
              fontSize: 13.5,
              fontWeight: 700,
            }}
          >
            <FireFilled style={{ color: 'var(--tm-action)', fontSize: 13 }} />
            最近浏览
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recents.length === 0 && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--tm-text-tertiary)',
                  padding: '9px 12px',
                  background: '#f7f8fa',
                  borderRadius: 10,
                  lineHeight: 1.7,
                }}
              >
                {isLoggedIn ? '还没有浏览记录，逛过的桌游会留在这里' : '登录后可记录最近浏览'}
              </div>
            )}
            {(showAllRecents ? recents : recents.slice(0, 3)).map((g) => {
              const active = location.pathname === `/games/${g.slug}`;
              return (
                <button
                  key={g.id}
                  onClick={() => navigate(`/games/${g.slug}`)}
                  className={`tm-press tm-nav-item${active ? ' tm-nav-active' : ''}`}
                  style={{
                    border: 'none',
                    borderRadius: 10,
                    padding: '6px 10px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                >
                  <img
                    src={g.cover_image}
                    alt=""
                    loading="lazy"
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      objectFit: 'cover',
                      flexShrink: 0,
                      background: '#f2f3f5',
                    }}
                  />
                  <span
                    className="tm-clamp-1"
                    style={{
                      fontSize: 14,
                      color: active ? 'var(--tm-action)' : '#374151',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {g.name}
                  </span>
                </button>
              );
            })}
            {recents.length > 3 && (
              <button
                onClick={() => setShowAllRecents((v) => !v)}
                aria-expanded={showAllRecents}
                className="tm-press tm-nav-item"
                style={{
                  border: 'none',
                  borderRadius: 10,
                  height: 38,
                  padding: '0 12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  color: '#6b7280',
                  fontSize: 13.5,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                {showAllRecents ? (
                  <UpOutlined style={{ fontSize: 12, color: '#9ca3af' }} />
                ) : (
                  <DownOutlined style={{ fontSize: 12, color: '#9ca3af' }} />
                )}
                {showAllRecents ? '收起' : `显示更多（${recents.length - 3}）`}
              </button>
            )}
          </div>

          <div style={{ height: 1, background: 'var(--tm-border)', margin: '10px 12px' }} />

          {/* 次级功能组：个人中心 / 管理列表 */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 6 }}>
            <button
              onClick={() => navigate(isLoggedIn ? '/profile' : '/login')}
              className={`tm-press tm-nav-item${selectedKey === '/profile' ? ' tm-nav-active' : ''}`}
              style={{
                border: 'none',
                color: selectedKey === '/profile' ? '#111827' : '#374151',
                fontWeight: selectedKey === '/profile' ? 700 : 500,
                fontSize: 15,
                height: 44,
                borderRadius: 10,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 12px',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  fontSize: 17,
                  display: 'inline-flex',
                  color: selectedKey === '/profile' ? 'var(--tm-action)' : '#6b7280',
                }}
              >
                <UserOutlined />
              </span>
              {isLoggedIn ? '个人中心' : '登录 / 注册'}
            </button>
            <button
              onClick={() => (isLoggedIn ? setManageOpen(true) : navigate('/login'))}
              aria-label="管理最近浏览"
              title="置顶或删除最近浏览记录"
              className="tm-press tm-nav-item"
              style={{
                border: 'none',
                color: '#374151',
                fontWeight: 500,
                fontSize: 15,
                height: 44,
                borderRadius: 10,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 12px',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 17, display: 'inline-flex', color: '#6b7280' }}>
                <SettingOutlined />
              </span>
              管理列表
            </button>
          </nav>
        </aside>
      ))}

      {/* ── 内容区：侧边栏已脱离文档流，这里整体让出它的宽度（沉浸式视图不让位） ── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          paddingLeft: !immersive ? (collapsed ? 64 : 264) : 0,
          transition: 'padding-left .2s var(--tm-ease-out)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: isAi ? '100%' : 1440,
            margin: '0 auto',
            padding: isAi ? 0 : '20px 22px 56px',
          }}
        >
          <main>
            <Outlet />
          </main>
        </div>
      </div>

      {!isAi && (
      <footer
        style={{
          textAlign: 'center',
          padding: '26px 0 34px',
          color: 'var(--tm-text-tertiary)',
          fontSize: 13,
          borderTop: '1px solid var(--tm-border)',
          background: '#fff',
        }}
      >
        <div style={{ marginBottom: 6 }}>
          <UserOutlined style={{ color: 'var(--tm-action)', marginRight: 6 }} />
          TapMind ©2026 桌游信息库 · 玩家社区 · AI 助手
        </div>
        <div>游戏资料来自 BoardGameGeek 公开数据，逐条标注来源</div>
      </footer>
      )}

      {/* 管理最近浏览：置顶 / 删除 / 跳转详情 */}
      <Modal
        open={manageOpen}
        onCancel={() => setManageOpen(false)}
        footer={null}
        width={520}
        title={
          <span style={{ fontSize: 16, fontWeight: 700 }}>
            管理最近浏览
            {manageList.length ? (
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: 'var(--tm-text-tertiary)' }}>
                共 {manageList.length} 条
              </span>
            ) : null}
          </span>
        }
      >
        {manageList.length === 0 ? (
          <div
            style={{
              padding: '34px 0 30px',
              textAlign: 'center',
              color: 'var(--tm-text-tertiary)',
              fontSize: 13,
            }}
          >
            还没有浏览记录，打开任意一款桌游详情页后会自动记录
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 460, overflowY: 'auto', paddingRight: 4 }}>
            {manageList.map((g, i) => (
              <div
                key={g.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '9px 11px',
                  borderRadius: 11,
                  border: i === 0 ? '1px solid var(--tm-action)' : '1px solid var(--tm-border)',
                  background: i === 0 ? 'var(--tm-tint)' : '#fff',
                }}
              >
                <img
                  src={g.cover_image}
                  alt=""
                  loading="lazy"
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 8,
                    objectFit: 'cover',
                    flexShrink: 0,
                    background: '#f2f3f5',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setManageOpen(false);
                    navigate(`/games/${g.slug}`);
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="tm-clamp-1" style={{ fontSize: 14, fontWeight: 600 }}>
                    {g.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 3 }}>
                    {i === 0 ? '当前已置顶' : `第 ${i + 1} 位`}
                  </div>
                </div>
                <button
                  className="tm-press"
                  aria-label={`将 ${g.name} 置顶`}
                  disabled={i === 0}
                  onClick={() => moveToTop(g.id)}
                  style={iconActBtn(i === 0)}
                >
                  <ArrowUpOutlined style={{ fontSize: 13, color: i === 0 ? '#9ca3af' : 'var(--tm-action)' }} />
                </button>
                <button
                  className="tm-press"
                  aria-label={`删除 ${g.name}`}
                  onClick={() => removeOne(g.id)}
                  style={iconActBtn(false)}
                >
                  <DeleteOutlined style={{ fontSize: 13, color: '#9ca3af' }} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <Button onClick={() => setManageOpen(false)}>关闭</Button>
        </div>
      </Modal>
    </div>
  );
}

/* ── 搜索面板里的通用样式 ── */
const chipBase: React.CSSProperties = {
  border: '1px solid var(--tm-border)',
  background: '#f5f6f8',
  color: '#4b5563',
  fontSize: 13,
  padding: '6px 13px',
  borderRadius: 999,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  whiteSpace: 'nowrap',
};

const textLinkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12.5,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontFamily: 'inherit',
};

/** 面板里的榜单：真实评分人数 / 真实均分排序，只取能查到详情的行 */
type RankRow = {
  id: number;
  name: string;
  avg_rating: number;
  rating_count: number;
  year_published: number | null;
};

function RankColumn({
  title,
  list,
  suffix,
}: {
  title: string;
  list: RankRow[];
  suffix: (r: RankRow) => string;
}) {
  const navigate = useNavigate();
  const items = list.filter((r) => gameLibrary.some((g) => g.id === r.id));
  return (
    <div>
      <div
        style={{
          fontSize: 14.5,
          fontWeight: 700,
          color: '#00b8a0',
          marginBottom: 10,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {title === '桌游热搜' ? <FireFilled style={{ fontSize: 13 }} /> : <StarOutlined style={{ fontSize: 13 }} />}
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((r, i) => (
          <button
            key={r.id}
            onClick={() => navigate(`/games/${r.id}`)}
            className="tm-press"
            style={{
              border: 'none',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 8px',
              borderRadius: 8,
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
          >
            <span
              style={{
                width: 17,
                textAlign: 'center',
                fontSize: 13,
                fontWeight: 700,
                flexShrink: 0,
                color: i < 3 ? '#00b8a0' : 'var(--tm-text-tertiary)',
                fontStyle: i < 3 ? 'italic' : 'normal',
              }}
            >
              {i + 1}
            </span>
            <span className="tm-clamp-1" style={{ flex: 1, fontSize: 13.5, color: '#374151' }}>
              {r.name}
            </span>
            {suffix(r) && (
              <span style={{ fontSize: 11.5, color: 'var(--tm-text-tertiary)', flexShrink: 0 }}>
                {suffix(r)}
              </span>
            )}
          </button>
        ))}
        {items.length === 0 && (
          <span style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)', padding: '6px 8px' }}>
            暂无可展示榜单
          </span>
        )}
      </div>
    </div>
  );
}

/** 面板内的小图标操作按钮 */
function iconActBtn(disabled: boolean): React.CSSProperties {
  return {
    border: '1px solid var(--tm-border-strong)',
    background: '#fff',
    width: 30,
    height: 30,
    borderRadius: 8,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    flexShrink: 0,
    fontFamily: 'inherit',
  };
}
