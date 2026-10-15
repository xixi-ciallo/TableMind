import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Pagination, message } from 'antd';
import {
  CommentOutlined,
  EyeOutlined,
  FireFilled,
  FireOutlined,
  LikeFilled,
  LikeOutlined,
  PlusOutlined,
  PushpinFilled,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { pageContainerStyle } from '../../shared/theme';
import { useIsMobile } from '../../shared/useIsMobile';
import client from '../../shared/api/client';
import { useAuthStore } from '../../stores/auth';
import { excerptOf, isNewPost } from '../../shared/postUtils';
import type { PostItem } from '../../shared/postUtils';

/** 热门话题：按浏览量排序的热门帖子（展示帖子标题，非桌游名） */
interface Topic {
  id: number;
  title: string;
  view_count: number;
}

interface HotSearch {
  term: string;
  count: number;
}

/** 分类标签：全部 / 官方公告 / 玩家讨论 */
const KINDS = [
  { key: 'all', label: '全部' },
  { key: 'official', label: '官方公告' },
  { key: 'discussion', label: '玩家讨论' },
];

const SORTS = [
  { key: 'new', label: '最新', icon: <PlusOutlined /> },
  { key: 'hot', label: '热门', icon: <FireOutlined /> },
];

/** 侧栏序号徽标（热门搜索 / 热门话题共用） */
function rankBadge(i: number) {
  return {
    width: 19,
    height: 19,
    borderRadius: 6,
    background: i < 3 ? 'var(--tm-tint-strong)' : '#f2f3f4',
    color: i < 3 ? 'var(--tm-action)' : 'var(--tm-text-tertiary)',
    fontSize: 11,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as const;
}

export default function CommunityPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const token = useAuthStore((s) => s.token);
  const isLoggedIn = Boolean(token);

  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('new');
  const [posts, setPosts] = useState<PostItem[] | null>(null);
  /** 分页：每页 10 条，页码变化或筛选变化时重新拉取 */
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 10;

  const [topics, setTopics] = useState<Topic[]>([]);
  const [hotSearches, setHotSearches] = useState<HotSearch[]>([]);
  /** 侧栏刷新版本号：发生搜索后自增，用于重拉「热门搜索」 */
  const [statsVer, setStatsVer] = useState(0);
  /** 关键词来自顶部搜索框跳转带来的 ?q=（社区内不再自带搜索框） */
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim();

  const load = useCallback(async () => {
    const params: Record<string, unknown> = { sort, kind, page, page_size: PAGE_SIZE };
    if (q) params.q = q;
    try {
      const { data } = await client.get<{ rows: PostItem[]; total: number }>('/posts', { params });
      setPosts(Array.isArray(data?.rows) ? data.rows : []);
      setTotal(typeof data?.total === 'number' ? data.total : 0);
    } catch {
      setPosts([]);
      setTotal(0);
    }
  }, [sort, kind, q, page]);

  useEffect(() => {
    load();
  }, [load]);

  /* 筛选 / 关键词变化时回到第一页 */
  useEffect(() => {
    setPage(1);
  }, [sort, kind, q]);

  /* 侧栏数据：挂载时拉一次；发生搜索后延迟重拉，确保 /search/log 已落库，
     这样「热门搜索」能跟着玩家的真实搜索数据更新 */
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      client
        .get<{ topics: Topic[]; hot_searches: HotSearch[] }>('/posts/stats')
        .then(({ data }) => {
          if (!alive) return;
          setTopics(data?.topics ?? []);
          setHotSearches(data?.hot_searches ?? []);
        })
        .catch(() => {});
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [statsVer, q]);

  /* 顶部搜索框完成一次搜索后，通知本页刷新侧栏 */
  useEffect(() => {
    const onSearch = () => setStatsVer((v) => v + 1);
    window.addEventListener('tablemind:search', onSearch);
    return () => window.removeEventListener('tablemind:search', onSearch);
  }, []);

  /** 点击热搜词条：按该词在社区内检索帖子，并记入真实搜索记录 */
  const doSearch = useCallback(
    (term: string) => {
      const t = term.trim();
      if (!t) {
        setSearchParams({});
        return;
      }
      client.post('/search/log', { kind: 'post', term: t }).catch(() => {});
      setSearchParams({ q: t });
    },
    [setSearchParams],
  );

  const toggleLike = async (post: PostItem) => {
    if (!isLoggedIn) {
      message.info('登录后才能点赞');
      return;
    }
    try {
      const { data } = await client.post<{ liked: boolean; like_count: number }>(`/posts/${post.id}/like`);
      setPosts((prev) =>
        (prev ?? []).map((p) =>
          p.id === post.id ? { ...p, liked: data.liked, like_count: data.like_count } : p,
        ),
      );
    } catch {
      message.error('操作失败，请重试');
    }
  };

  const goNew = () => {
    if (!isLoggedIn) {
      message.info('发布帖子前请先登录');
      navigate('/login');
      return;
    }
    navigate('/community/new');
  };

  /** TapTap 风格列表行 */
  const PostRow = ({ p, index }: { p: PostItem; index: number }) => {
    const top3 = index < 3;
    return (
      <article
        onClick={() => navigate(`/community/${p.id}`)}
        className="tm-press"
        style={{
          display: 'flex',
          gap: 16,
          padding: '18px 8px',
          borderBottom: '1px solid var(--tm-border)',
          cursor: 'pointer',
          alignItems: 'flex-start',
        }}
      >
        <span
          style={{
            width: 44,
            flexShrink: 0,
            textAlign: 'center',
            fontSize: top3 ? 30 : 20,
            fontWeight: 800,
            fontStyle: 'italic',
            fontFamily: 'Georgia, "Times New Roman", serif',
            lineHeight: 1.1,
            color: top3 ? 'var(--tm-action)' : 'var(--tm-rank, #c9cdd4)',
            paddingTop: 2,
          }}
        >
          {index + 1}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {p.is_official && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#fff',
                  background: 'var(--tm-action)',
                  borderRadius: 5,
                  padding: '1.5px 7px',
                  flexShrink: 0,
                }}
              >
                官方
              </span>
            )}
            {p.is_pinned && !p.is_official && (
              <PushpinFilled style={{ color: 'var(--tm-text-tertiary)', fontSize: 12 }} />
            )}
            <h3
              style={{
                margin: 0,
                fontSize: 16.5,
                fontWeight: 700,
                color: 'var(--tm-text-primary)',
                lineHeight: 1.45,
              }}
              className="tm-clamp-1"
            >
              {p.title}
            </h3>
            {isNewPost(p.created_at) && (
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  color: '#fff',
                  background: 'var(--tm-rating, #e0a030)',
                  borderRadius: 4,
                  padding: '1px 5px',
                  flexShrink: 0,
                }}
              >
                NEW
              </span>
            )}
          </div>

          <p
            style={{
              margin: '7px 0 0',
              fontSize: 13.5,
              color: 'var(--tm-text-secondary)',
              lineHeight: 1.7,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {excerptOf(p.content, 80)}
          </p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginTop: 10,
              fontSize: 12.5,
              color: 'var(--tm-text-tertiary)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CommentOutlined /> {p.comment_count} 评论
            </span>
            {p.game_id && p.game_name && (
              <>
                <span style={{ color: 'var(--tm-border-strong)' }}>·</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/games/${p.game_id}`);
                  }}
                  className="tm-clamp-1"
                  style={{ color: 'var(--tm-text-secondary)', maxWidth: 180 }}
                >
                  {p.game_name}
                </span>
              </>
            )}
            <span style={{ flex: 1 }} />
            <span
              onClick={(e) => {
                e.stopPropagation();
                toggleLike(p);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
                color: p.liked ? 'var(--tm-action)' : 'var(--tm-text-tertiary)',
                fontWeight: p.liked ? 700 : 400,
              }}
            >
              {p.liked ? <LikeFilled /> : <LikeOutlined />} {p.like_count}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <EyeOutlined /> {p.view_count}
            </span>
          </div>
        </div>

        {/* 缩略图：只取帖子正文里的图片（没有图片则用视频首帧，都没有就不占位） */}
        {p.cover_image ? (
          <img
            src={p.cover_image}
            alt=""
            loading="lazy"
            style={{
              width: 116,
              height: 78,
              objectFit: 'cover',
              borderRadius: 10,
              flexShrink: 0,
              background: '#f2f3f4',
            }}
          />
        ) : p.cover_video ? (
          <video
            src={`${p.cover_video}#t=0.1`}
            muted
            preload="metadata"
            style={{
              width: 116,
              height: 78,
              objectFit: 'cover',
              borderRadius: 10,
              flexShrink: 0,
              background: '#0d1117',
            }}
          />
        ) : null}
      </article>
    );
  };

  return (
    <div
      className="tm-page-enter"
      style={{
        ...pageContainerStyle,
        display: 'flex',
        gap: 20,
        alignItems: 'flex-start',
        padding: isMobile ? '8px 16px 72px' : undefined,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 标题 + 发帖 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: 'var(--tm-text-primary)' }}>
            社区
          </h1>
          <Button type="primary" icon={<PlusOutlined />} onClick={goNew}>
            发布新帖
          </Button>
        </div>

        {/* 检索词 chip */}
        {q && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--tm-tint)',
              color: 'var(--tm-action)',
              borderRadius: 999,
              padding: '5px 12px',
              fontSize: 12.5,
              fontWeight: 600,
              marginBottom: 12,
              cursor: 'pointer',
            }}
            onClick={() => setSearchParams({})}
          >
            搜索：{q} ✕
          </div>
        )}

        {/* 分类 + 排序 */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {KINDS.map((k) => (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              className="tm-press"
              style={{
                border: 'none',
                cursor: 'pointer',
                borderRadius: 999,
                padding: '6px 16px',
                fontSize: 13.5,
                fontWeight: kind === k.key ? 700 : 400,
                background: kind === k.key ? 'var(--tm-tint-strong)' : '#fff',
                color: kind === k.key ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
                fontFamily: 'inherit',
              }}
            >
              {k.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              className="tm-press"
              style={{
                border: 'none',
                cursor: 'pointer',
                borderRadius: 999,
                padding: '6px 14px',
                fontSize: 13,
                fontWeight: sort === s.key ? 700 : 400,
                background: sort === s.key ? 'var(--tm-action)' : '#fff',
                color: sort === s.key ? '#fff' : 'var(--tm-text-secondary)',
                fontFamily: 'inherit',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* 帖子流 */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid var(--tm-border)', padding: '2px 18px' }}>
          {posts === null && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--tm-text-tertiary)' }}>
              加载中…
            </div>
          )}
          {posts !== null && posts.length === 0 && (
            <div style={{ padding: '24px 0' }}>
              <Empty description={q ? '没有匹配的帖子' : '还没有帖子，来发第一条吧'} />
            </div>
          )}
          {(posts ?? []).map((p, i) => (
            <PostRow key={p.id} p={p} index={(page - 1) * PAGE_SIZE + i} />
          ))}
          {/* 分页：真实总数由后端聚合返回 */}
          {total > PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '18px 0 20px' }}>
              <Pagination
                current={page}
                pageSize={PAGE_SIZE}
                total={total}
                showSizeChanger={false}
                onChange={(p) => {
                  setPage(p);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* 右侧栏：热门搜索（真实搜索记录）+ 热门话题（按浏览量，不展示数据） */}
      <aside style={{ width: 288, flexShrink: 0, display: isMobile ? 'none' : 'block' }}>
        <div
          style={{
            background: '#fff',
            border: '1px solid var(--tm-border)',
            borderRadius: 14,
            padding: 16,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontWeight: 800,
              fontSize: 14,
              marginBottom: 10,
              color: 'var(--tm-text-primary)',
            }}
          >
            <FireFilled style={{ color: 'var(--tm-action)' }} /> 热门搜索
          </div>
          {hotSearches.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}>
              暂无搜索记录，搜索后会实时更新
            </div>
          )}
          <div>
            {hotSearches.map((h, i) => (
              <div
                key={h.term}
                onClick={() => doSearch(h.term)}
                className="tm-press"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '7px 0',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'var(--tm-text-primary)',
                }}
              >
                <span style={rankBadge(i)}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0 }} className="tm-clamp-1">
                  {h.term}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            background: '#fff',
            border: '1px solid var(--tm-border)',
            borderRadius: 14,
            padding: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontWeight: 800,
              fontSize: 14,
              marginBottom: 10,
              color: 'var(--tm-text-primary)',
            }}
          >
            <FireFilled style={{ color: 'var(--tm-rating)' }} /> 热门话题
          </div>
          {topics.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}>还没有帖子</div>
          )}
          {topics.map((t, i) => (
            <div
              key={t.id}
              onClick={() => navigate(`/community/${t.id}`)}
              className="tm-press"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 0',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--tm-text-primary)',
              }}
            >
              <span style={rankBadge(i)}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0 }} className="tm-clamp-1">
                {t.title}
              </span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
