import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Spin,
  Tabs,
  message,
} from 'antd';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import client from '../../shared/api/client';
import { useAuthStore } from '../../stores/auth';
import { pageContainerStyle } from '../../shared/theme';
import {
  readRecentEntries,
  removeRecentEntry,
  type RecentEntry,
} from '../../shared/recentHistory';
import { getGameByIdOrSlug } from '../../shared/gameLibrary';
import { useIsMobile } from '../../shared/useIsMobile';
import type { User } from '../../shared/types';

/** 手机号脱敏展示：138****1234 */
function maskPhone(phone?: string | null): string {
  if (!phone || phone.length < 7) return phone ?? '—';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function fmt(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 个人中心统计（GET /me/stats 真实聚合） */
type Stats = {
  want: number;
  played: number;
  owned: number;
  reviews: number;
  posts: number;
};

type CollectionItem = {
  id: number;
  game_id: number;
  status: 'want' | 'played' | 'owned';
  created_at: string;
  game_name: string | null;
  cover_image: string | null;
};

type MarkedPost = {
  post_id: number;
  marked_at: string;
  title: string;
  author_name: string;
  cover_image: string | null;
  like_count: number;
  comment_count: number;
  view_count: number;
};

type MyReview = {
  id: number;
  game_id: number;
  /** 只写了评测正文时没有分数 */
  rating: number | null;
  content: string | null;
  like_count: number;
  comment_count: number;
  created_at: string;
  game_name?: string;
};

type MyPost = {
  id: number;
  title: string;
  created_at: string;
  like_count: number;
  comment_count: number;
  cover_image: string | null;
};

const STATUS_LABEL: Record<CollectionItem['status'], string> = {
  want: '想玩',
  played: '玩过',
  owned: '拥有',
};

const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 浏览历史按日期分组：今天 / 昨天 M月D日 周X / 前天 … / 更早之前（参考 TapTap 口径） */
function groupHistory(entries: RecentEntry[]): { label: string; items: RecentEntry[] }[] {
  const dayStart = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = dayStart(Date.now());
  const buckets: { label: string; items: RecentEntry[] }[] = [];
  const push = (label: string, e: RecentEntry) => {
    let b = buckets.find((x) => x.label === label);
    if (!b) {
      b = { label, items: [] };
      buckets.push(b);
    }
    b.items.push(e);
  };
  for (const e of entries) {
    if (!e.ts) {
      push('更早之前', e);
      continue;
    }
    const diff = Math.round((today - dayStart(e.ts)) / 86400000);
    const d = new Date(e.ts);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    if (diff <= 0) push('今天', e);
    else if (diff === 1) push(`昨天 ${md} ${WEEK_LABEL[d.getDay()]}`, e);
    else if (diff === 2) push(`前天 ${md} ${WEEK_LABEL[d.getDay()]}`, e);
    else push('更早之前', e);
  }
  return buckets;
}

export default function ProfilePage() {
  const { user, setUser } = useAuthStore();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [marks, setMarks] = useState<MarkedPost[]>([]);
  const [reviews, setReviews] = useState<MyReview[]>([]);
  const [posts, setPosts] = useState<MyPost[]>([]);
  const [history, setHistory] = useState<RecentEntry[]>([]);

  // 收藏页内分类（合并后的「收藏」tab：桌游 / 帖子两个胶囊按钮）
  const [collectSub, setCollectSub] = useState<'games' | 'posts'>('games');
  // 浏览历史管理模式（圈选 + 底部操作条）
  const [manageMode, setManageMode] = useState(false);
  const [selIds, setSelIds] = useState<number[]>([]);

  // 当前 tab：支持 ?tab= 直达（顶栏弹层入口），页内切换时清掉参数
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') ?? 'collections');
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t) setActiveTab(t);
    setCollectSub(searchParams.get('sub') === 'posts' ? 'posts' : 'games');
    if (searchParams.get('pwd') === '1') setPwdOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // 编辑资料 / 头像 / 简介
  const [editOpen, setEditOpen] = useState(false);
  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 修改密码
  const [pwdOpen, setPwdOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);

  const refreshStats = async () => {
    try {
      const { data } = await client.get<Stats>('/me/stats');
      setStats(data);
    } catch {
      /* 统计失败不打断操作 */
    }
  };

  const refreshHistory = () => setHistory(readRecentEntries());

  const loadAll = async () => {
    setLoading(true);
    try {
      const [s, c, m, r, p] = await Promise.all([
        client.get<Stats>('/me/stats'),
        client.get<CollectionItem[]>('/collections'),
        client.get<MarkedPost[]>('/posts/marks'),
        client.get<MyReview[]>('/reviews', { params: { mine: true } }),
        client.get<{ rows: MyPost[] }>('/posts', { params: { mine: true, page_size: 50 } }),
      ]);
      setStats(s.data);
      setCollections(c.data);
      setMarks(m.data);
      setReviews(r.data);
      setPosts(p.data.rows ?? []);
    } catch {
      message.error('个人数据加载失败，请确认已登录且后端正常');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    void loadAll();
    refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // 未登录：给出明确入口，而不是显示一份假的个人资料
  if (!user) {
    return (
      <div style={{ ...pageContainerStyle, padding: isMobile ? '8px 16px 72px' : undefined }}>
        <div
          style={{
            background: '#fff',
            borderRadius: 18,
            padding: '56px 24px',
            boxShadow: '0 2px 8px rgba(17,24,39,.06)',
            textAlign: 'center',
          }}
        >
          <Empty description="登录后可查看你的收藏、评测与帖子">
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <Button type="primary" onClick={() => navigate('/login')}>
                去登录
              </Button>
              <Button onClick={() => navigate('/register')}>注册新账号</Button>
            </div>
          </Empty>
        </div>
      </div>
    );
  }

  const changeStatus = async (item: CollectionItem, status: CollectionItem['status']) => {
    try {
      await client.put(`/collections/${item.id}`, { status });
      setCollections((prev) => prev.map((x) => (x.id === item.id ? { ...x, status } : x)));
      await refreshStats();
      message.success(`已标记为「${STATUS_LABEL[status]}」`);
    } catch {
      message.error('更新失败，请稍后重试');
    }
  };

  const removeCollection = async (item: CollectionItem) => {
    try {
      await client.delete(`/collections/${item.id}`);
      setCollections((prev) => prev.filter((x) => x.id !== item.id));
      await refreshStats();
      message.success('已取消收藏');
    } catch {
      message.error('删除失败，请稍后重试');
    }
  };

  const openEdit = () => {
    setNickname(user.username);
    setBio(user.bio ?? '');
    setEditOpen(true);
  };

  const saveProfile = async () => {
    const name = nickname.trim();
    if (!name) {
      message.warning('昵称不能为空');
      return;
    }
    setSavingProfile(true);
    try {
      const { data } = await client.patch<User>('/me/profile', { username: name, bio });
      setUser(data);
      message.success('资料已更新');
      setEditOpen(false);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof detail === 'string' ? detail : '保存失败，请稍后重试');
    } finally {
      setSavingProfile(false);
    }
  };

  const onPickAvatar = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.warning('请选择图片文件');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      message.warning('头像不能超过 4MB');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      const { data } = await client.post<User>('/me/avatar', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setUser(data);
      message.success('头像已更新');
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof detail === 'string' ? detail : '上传失败，请稍后重试');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submitPassword = async () => {
    if (!oldPwd || !newPwd) {
      message.warning('请填写原密码与新密码');
      return;
    }
    if (newPwd.length < 6) {
      message.warning('新密码至少 6 位');
      return;
    }
    if (newPwd !== newPwd2) {
      message.warning('两次输入的新密码不一致');
      return;
    }
    setSavingPwd(true);
    try {
      await client.post('/me/password', { old_password: oldPwd, new_password: newPwd });
      message.success('密码已修改，下次登录请使用新密码');
      setPwdOpen(false);
      setOldPwd('');
      setNewPwd('');
      setNewPwd2('');
      if (searchParams.get('pwd') === '1') setSearchParams({});
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof detail === 'string' ? detail : '修改失败，请稍后重试');
    } finally {
      setSavingPwd(false);
    }
  };

  const toggleSel = (id: number) =>
    setSelIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const selectAllHistory = () =>
    setSelIds(selIds.length === history.length ? [] : history.map((e) => e.id));

  const deleteSelectedHistory = () => {
    const n = selIds.length;
    if (!n) return;
    selIds.forEach((id) => removeRecentEntry(id));
    refreshHistory();
    setSelIds([]);
    message.success(`已删除 ${n} 条浏览记录`);
  };

  const pad = isMobile ? '8px 16px 72px' : undefined;

  return (
    <div style={{ ...pageContainerStyle, padding: pad }} className="tm-page-enter">
      {/* 头部卡片 */}
      <div
        style={{
          background: '#fff',
          borderRadius: 18,
          padding: isMobile ? '0 20px 22px' : '0 32px 26px',
          boxShadow: '0 2px 8px rgba(17,24,39,.06)',
          marginBottom: 18,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 88,
            background: 'linear-gradient(120deg, #ff8f6d, #e8502a 60%, #c43715)',
          }}
        />
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 16,
            paddingTop: 52,
            flexWrap: 'wrap',
          }}
        >
          {user.avatar ? (
            <img
              src={user.avatar}
              alt={user.username}
              style={{
                width: 84,
                height: 84,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '3px solid #fff',
                boxShadow: '0 6px 16px rgba(17,24,39,.18)',
                flexShrink: 0,
                background: '#fff',
              }}
            />
          ) : (
            <Avatar
              size={84}
              style={{
                background: 'linear-gradient(135deg, #ff8f6d, #d93d1a)',
                color: '#fff',
                fontSize: 34,
                fontWeight: 700,
                border: '3px solid #fff',
                boxShadow: '0 6px 16px rgba(17,24,39,.18)',
                flexShrink: 0,
              }}
            >
              {user.username.charAt(0).toUpperCase()}
            </Avatar>
          )}
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{user.username}</div>
            <div style={{ color: 'var(--tm-text-secondary)', fontSize: 13, marginTop: 3 }}>
              {maskPhone(user.phone)} · {user.role === 'admin' ? '管理员' : '普通用户'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon={<EditOutlined />} onClick={openEdit}>
              编辑资料
            </Button>
            <Button icon={<SettingOutlined />} aria-label="账号设置" onClick={() => setPwdOpen(true)} />
          </div>
        </div>

        {/* 个人简介 */}
        <div style={{ position: 'relative', marginTop: 14, fontSize: 13.5, lineHeight: 1.7, color: 'var(--tm-text-secondary)' }}>
          {user.bio ? user.bio : '还没有个人简介，点「编辑资料」写一个吧'}
        </div>

        {/* 统计条：真实聚合数据 */}
        <div
          style={{
            display: 'flex',
            gap: isMobile ? 22 : 44,
            marginTop: 18,
            paddingTop: 18,
            borderTop: '1px solid var(--tm-border)',
            flexWrap: 'wrap',
          }}
        >
          <StatItem value={stats?.owned ?? 0} label="拥有" />
          <StatItem value={stats?.played ?? 0} label="玩过" />
          <StatItem value={stats?.want ?? 0} label="想玩" />
          <StatItem value={stats?.reviews ?? 0} label="评测" />
          <StatItem value={stats?.posts ?? 0} label="帖子" />
        </div>
      </div>

      {/* 内容 tabs */}
      <div
        style={{
          background: '#fff',
          borderRadius: 18,
          padding: isMobile ? '8px 16px 20px' : '8px 28px 24px',
          boxShadow: '0 2px 8px rgba(17,24,39,.06)',
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Spin />
          </div>
        ) : (
          <Tabs
            size="large"
            activeKey={activeTab}
            onChange={(k) => {
              setActiveTab(k);
              if (k !== 'history') {
                setManageMode(false);
                setSelIds([]);
              }
              if (searchParams.get('tab') || searchParams.get('pwd')) setSearchParams({});
            }}
            items={[
              {
                key: 'collections',
                label: `收藏 (${collections.length + marks.length})`,
                children: (
                  <div>
                    {/* 分类胶囊按钮（参考图1：选中深色底白字） */}
                    <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
                      {(
                        [
                          { key: 'games', label: `桌游 (${collections.length})` },
                          { key: 'posts', label: `帖子 (${marks.length})` },
                        ] as const
                      ).map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => setCollectSub(s.key)}
                          style={{
                            border: `1px solid ${collectSub === s.key ? 'transparent' : 'var(--tm-border)'}`,
                            background: collectSub === s.key ? '#1f2329' : '#fff',
                            color: collectSub === s.key ? '#fff' : 'inherit',
                            borderRadius: 999,
                            padding: '7px 20px',
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'all .15s var(--tm-ease)',
                          }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    {collectSub === 'games' ? (
                      collections.length ? (
                        <div style={{ display: 'grid', gap: 12 }}>
                          {collections.map((c) => (
                            <div
                              key={c.id}
                              style={{
                                display: 'flex',
                                gap: 12,
                                alignItems: 'center',
                                padding: 12,
                                border: '1px solid var(--tm-border)',
                                borderRadius: 12,
                                flexWrap: 'wrap',
                              }}
                            >
                              <img
                                src={c.cover_image || '/logo.svg'}
                                alt=""
                                onClick={() => navigate(`/games/${c.game_id}`)}
                                style={{
                                  width: 56,
                                  height: 56,
                                  borderRadius: 8,
                                  objectFit: 'cover',
                                  cursor: 'pointer',
                                  background: 'var(--tm-tint)',
                                  flexShrink: 0,
                                }}
                              />
                              <div style={{ flex: 1, minWidth: 140 }}>
                                <div
                                  style={{ fontWeight: 700, cursor: 'pointer' }}
                                  onClick={() => navigate(`/games/${c.game_id}`)}
                                >
                                  {c.game_name ?? '（桌游已下架）'}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 2 }}>
                                  收藏于 {fmt(c.created_at)}
                                </div>
                              </div>
                              <Select
                                size="small"
                                value={c.status}
                                style={{ width: 96 }}
                                onChange={(v) => void changeStatus(c, v)}
                                options={[
                                  { value: 'want', label: '想玩' },
                                  { value: 'played', label: '玩过' },
                                  { value: 'owned', label: '拥有' },
                                ]}
                              />
                              <Button
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => void removeCollection(c)}
                              >
                                取消
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty description="还没有收藏桌游，去桌游库看看吧" style={{ padding: '40px 0' }}>
                          <Button type="primary" onClick={() => navigate('/games')}>
                            浏览桌游库
                          </Button>
                        </Empty>
                      )
                    ) : marks.length ? (
                      <div style={{ display: 'grid', gap: 12 }}>
                        {marks.map((m) => (
                          <div
                            key={m.post_id}
                            style={{
                              display: 'flex',
                              gap: 12,
                              alignItems: 'center',
                              padding: 12,
                              border: '1px solid var(--tm-border)',
                              borderRadius: 12,
                              cursor: 'pointer',
                            }}
                            onClick={() => navigate(`/community/${m.post_id}`)}
                          >
                            {m.cover_image && (
                              <img
                                src={m.cover_image}
                                alt=""
                                style={{
                                  width: 72,
                                  height: 54,
                                  borderRadius: 8,
                                  objectFit: 'cover',
                                  flexShrink: 0,
                                }}
                              />
                            )}
                            <div style={{ flex: 1, minWidth: 120 }}>
                              <div style={{ fontWeight: 700 }}>{m.title}</div>
                              <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 4 }}>
                                {m.author_name} · 收藏于 {fmt(m.marked_at)} · {m.like_count} 赞 · {m.comment_count} 评论 · {m.view_count} 浏览
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty description="还没有收藏帖子，去社区逛逛吧" style={{ padding: '40px 0' }}>
                        <Button type="primary" onClick={() => navigate('/community')}>
                          逛逛社区
                        </Button>
                      </Empty>
                    )}
                  </div>
                ),
              },
              {
                key: 'history',
                label: `浏览历史 (${history.length})`,
                children: history.length ? (
                  <div>
                    {/* 右上角管理入口（参考图2） */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
                      <Button
                        size="small"
                        onClick={() => {
                          setManageMode(true);
                          setSelIds([]);
                        }}
                      >
                        管理
                      </Button>
                    </div>
                    {groupHistory(history).map((g, gi, arr) => (
                      <div
                        key={g.label}
                        style={{
                          paddingBottom: gi < arr.length - 1 ? 14 : 0,
                          marginBottom: gi < arr.length - 1 ? 14 : 0,
                          borderBottom: gi < arr.length - 1 ? '1px solid var(--tm-border)' : 'none',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontWeight: 700,
                            fontSize: 14.5,
                            margin: '12px 0 8px',
                          }}
                        >
                          <CalendarOutlined style={{ color: 'var(--tm-text-tertiary)', fontWeight: 400 }} />
                          {g.label}
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))',
                            gap: '2px 28px',
                          }}
                        >
                          {g.items.map((e) => {
                            const gm = getGameByIdOrSlug(e.id);
                            if (!gm) return null;
                            const checked = selIds.includes(e.id);
                            return (
                              <div
                                key={e.id}
                                onClick={() => {
                                  if (manageMode) toggleSel(e.id);
                                  else navigate(`/games/${gm.slug}`);
                                }}
                                style={{
                                  display: 'flex',
                                  gap: 12,
                                  alignItems: 'center',
                                  padding: '10px 8px',
                                  borderRadius: 12,
                                  cursor: 'pointer',
                                  background: checked ? 'var(--tm-tint)' : 'transparent',
                                  transition: 'background .15s var(--tm-ease)',
                                }}
                              >
                                {manageMode && (
                                  <span
                                    style={{
                                      width: 20,
                                      height: 20,
                                      borderRadius: '50%',
                                      border: checked ? 'none' : '1.5px solid var(--tm-border)',
                                      background: checked ? 'var(--tm-action)' : '#fff',
                                      color: '#fff',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      flexShrink: 0,
                                      fontSize: 11,
                                    }}
                                  >
                                    {checked && <CheckOutlined />}
                                  </span>
                                )}
                                <img
                                  src={gm.cover_image}
                                  alt=""
                                  style={{
                                    width: 52,
                                    height: 52,
                                    borderRadius: 10,
                                    objectFit: 'cover',
                                    flexShrink: 0,
                                    background: 'var(--tm-tint)',
                                  }}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div
                                    style={{
                                      fontWeight: 700,
                                      fontSize: 14.5,
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                    }}
                                  >
                                    {gm.name}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 12.5,
                                      marginTop: 3,
                                      color: 'var(--tm-text-tertiary)',
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                    }}
                                  >
                                    {gm.avg_rating != null && (
                                      <span style={{ color: 'var(--tm-action)', fontWeight: 700, marginRight: 8 }}>
                                        ★ {gm.avg_rating.toFixed(1)}
                                      </span>
                                    )}
                                    {gm.categories.slice(0, 3).join(' · ')}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {manageMode && <div style={{ height: 72 }} />}
                  </div>
                ) : (
                  <Empty description="还没有浏览记录，去看几款桌游吧" style={{ padding: '40px 0' }}>
                    <Button type="primary" onClick={() => navigate('/games')}>
                      浏览桌游库
                    </Button>
                  </Empty>
                ),
              },
              {
                key: 'reviews',
                label: `我的评测 (${reviews.length})`,
                children: reviews.length ? (
                  <div style={{ display: 'grid', gap: 12 }}>
                    {reviews.map((r) => (
                      <div
                        key={r.id}
                        style={{
                          padding: 14,
                          border: '1px solid var(--tm-border)',
                          borderRadius: 12,
                          cursor: 'pointer',
                        }}
                        onClick={() => navigate(`/games/${r.game_id}`)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontWeight: 700 }}>{r.game_name ?? '桌游'}</span>
                          <span style={{ color: 'var(--tm-action)', fontWeight: 700 }}>
                            {r.rating != null ? `${r.rating} 分` : '未评分'}
                          </span>
                        </div>
                        {r.content && (
                          <div
                            style={{
                              marginTop: 6,
                              color: 'var(--tm-text-secondary)',
                              fontSize: 13.5,
                              lineHeight: 1.7,
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {r.content}
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 6 }}>
                          {fmt(r.created_at)} · {r.like_count} 赞 · {r.comment_count} 回复
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty description="还没有写过评测" style={{ padding: '40px 0' }} />
                ),
              },
              {
                key: 'posts',
                label: `我的帖子 (${posts.length})`,
                children: posts.length ? (
                  <div style={{ display: 'grid', gap: 12 }}>
                    {posts.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          display: 'flex',
                          gap: 12,
                          alignItems: 'center',
                          padding: 12,
                          border: '1px solid var(--tm-border)',
                          borderRadius: 12,
                          cursor: 'pointer',
                        }}
                        onClick={() => navigate(`/community/${p.id}`)}
                      >
                        {p.cover_image && (
                          <img
                            src={p.cover_image}
                            alt=""
                            style={{
                              width: 64,
                              height: 48,
                              borderRadius: 8,
                              objectFit: 'cover',
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <div style={{ fontWeight: 700 }}>{p.title}</div>
                          <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 2 }}>
                            {fmt(p.created_at)} · {p.like_count} 赞 · {p.comment_count} 评论
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty description="还没有发布过帖子" style={{ padding: '40px 0' }}>
                    <Button type="primary" onClick={() => navigate('/community/new')}>
                      去发帖
                    </Button>
                  </Empty>
                ),
              },
            ]}
          />
        )}
      </div>

      {/* 浏览历史管理模式：底部浮动操作条（参考图3） */}
      {manageMode && activeTab === 'history' && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: isMobile ? 84 : 32,
            zIndex: 60,
            background: '#fff',
            borderRadius: 999,
            boxShadow: '0 8px 28px rgba(17,24,39,.2)',
            padding: '8px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          <span style={{ fontSize: 13.5, color: 'var(--tm-text-secondary)', padding: '0 12px', whiteSpace: 'nowrap' }}>
            已选 {selIds.length}
          </span>
          <div style={{ width: 1, height: 18, background: 'var(--tm-border)' }} />
          <Button type="text" icon={<CheckCircleOutlined />} onClick={selectAllHistory}>
            全选
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} disabled={!selIds.length} onClick={deleteSelectedHistory}>
            删除
          </Button>
          <Button
            type="primary"
            style={{ borderRadius: 999, paddingInline: 24, marginLeft: 4 }}
            onClick={() => {
              setManageMode(false);
              setSelIds([]);
            }}
          >
            完成
          </Button>
        </div>
      )}

      {/* 编辑资料 */}
      <Modal
        title="编辑资料"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => void saveProfile()}
        confirmLoading={savingProfile}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ display: 'grid', gap: 16, paddingTop: 8 }}>
          <div>
            <div style={{ marginBottom: 6, fontSize: 13, color: 'var(--tm-text-secondary)' }}>昵称</div>
            <Input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={50}
              placeholder="请输入昵称"
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontSize: 13, color: 'var(--tm-text-secondary)' }}>个人简介</div>
            <Input.TextArea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={500}
              rows={3}
              showCount
              placeholder="介绍一下自己（选填）"
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontSize: 13, color: 'var(--tm-text-secondary)' }}>头像</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt=""
                  style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }}
                />
              ) : (
                <Avatar size={56} style={{ background: 'linear-gradient(135deg,#ff8f6d,#d93d1a)' }}>
                  {user.username.charAt(0).toUpperCase()}
                </Avatar>
              )}
              <Button icon={<EditOutlined />} loading={uploading} onClick={() => fileRef.current?.click()}>
                上传新头像
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickAvatar(f);
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 6 }}>
              支持 jpg / png / webp / gif，不超过 4MB
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}>
            登录手机号 {maskPhone(user.phone)} 不可修改。
          </div>
        </div>
      </Modal>

      {/* 修改密码 */}
      <Modal
        title="修改密码"
        open={pwdOpen}
        onCancel={() => {
          setPwdOpen(false);
          if (searchParams.get('pwd') === '1') setSearchParams({});
        }}
        onOk={() => void submitPassword()}
        confirmLoading={savingPwd}
        okText="确认修改"
        cancelText="取消"
      >
        <div style={{ display: 'grid', gap: 12, paddingTop: 8 }}>
          <Input.Password
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            placeholder="原密码"
            autoComplete="current-password"
          />
          <Input.Password
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            placeholder="新密码（至少 6 位）"
            autoComplete="new-password"
          />
          <Input.Password
            value={newPwd2}
            onChange={(e) => setNewPwd2(e.target.value)}
            placeholder="确认新密码"
            autoComplete="new-password"
          />
        </div>
      </Modal>
    </div>
  );
}

function StatItem({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--tm-action)' }}>{value}</div>
      <div style={{ color: 'var(--tm-text-secondary)', fontSize: 12, marginTop: 2 }}>{label}</div>
    </div>
  );
}
