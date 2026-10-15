import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Divider, Dropdown, Empty, Input, Modal, Rate, Skeleton, Space, Tag, Tooltip, Upload } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CommentOutlined,
  CompassOutlined,
  EllipsisOutlined,
  FilePdfOutlined,
  LeftOutlined,
  RightOutlined,
  HeartOutlined,
  IdcardOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  PlayCircleFilled,
  ReadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  StarOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
  ZoomInOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import {
  formatAge,
  formatDuration,
  formatPlayTime,
  formatPlayers,
  formatViews,
  getGameByIdOrSlug,
  getSimilarGames,
  type GameDetail,
  type GameImage,
  type TeachingVideo,
} from '../../shared/gameLibrary';
import { pageContainerStyle } from '../../shared/theme';
import { pushRecentEntry } from '../../shared/recentHistory';
import { ruleBooks } from '../../shared/ruleBooks';
import { fetchPublicRuleBooks } from '../../admin/adminApi';
import type { AdminRuleBook } from '../../admin/adminTypes';
import { useIsMobile } from '../../shared/useIsMobile';
import BackButton from '../../shared/BackButton';
import Lightbox, { type LightboxItem } from '../../shared/Lightbox';
import client from '../../shared/api/client';
import { useAuthStore } from '../../stores/auth';

/** 本站真实评测（GET /reviews 返回结构） */
type SiteReview = {
  id: number;
  user_id: number;
  game_id: number;
  rating: number;
  content: string | null;
  like_count: number;
  created_at: string;
  username: string;
  game_name?: string;
  images?: string[];
  comment_count: number;
  liked: boolean;
};

/** 评测回复 */
type ReviewComment = {
  id: number;
  review_id: number;
  user_id: number;
  content: string;
  created_at: string;
  username: string;
};

/** 跳转外部站点（B 站 / BGG）前的二次确认 */
function useExternalConfirm() {
  const [pending, setPending] = useState<{ url: string; label: string; author?: string } | null>(null);

  const ask = (url: string, label: string, author?: string) => setPending({ url, label, author });

  const modal = (
    <Modal
      open={!!pending}
      title="即将离开 TableMind"
      okText="打开外部页面"
      cancelText="留在本页"
      onCancel={() => setPending(null)}
      onOk={() => {
        if (pending) window.open(pending.url, '_blank', 'noopener,noreferrer');
        setPending(null);
      }}
    >
      <p style={{ margin: '0 0 8px', color: 'var(--tm-text-secondary)' }}>你将要打开的是外部网站内容：</p>
      <p style={{ margin: '0 0 12px', fontWeight: 600, wordBreak: 'break-all' }}>{pending?.label}</p>
      {pending?.author && (
        <p style={{ margin: '0 0 12px', color: 'var(--tm-text-secondary)', fontSize: 13 }}>
          UP 主：{pending.author}
        </p>
      )}
      <p style={{ margin: 0, color: 'var(--tm-text-secondary)', fontSize: 13 }}>
        该内容由第三方平台提供，将在新标签页打开。TableMind 仅收录链接，不对第三方内容负责。
      </p>
    </Modal>
  );

  return { ask, modal };
}

/** 收藏三态的中文标签 */
const WISH_LABEL: Record<'want' | 'played' | 'owned', string> = {
  want: '想玩',
  played: '玩过',
  owned: '拥有',
};

/** 后端库里可维护的字段（管理员在后台改这些，前台应随之更新） */
interface LiveGameFields {
  description?: string | null;
  designers?: string[] | null;
  artists?: string[] | null;
  bgg_url?: string | null;
  min_playtime?: number | null;
  max_playtime?: number | null;
  publisher?: string | null;
  year_published?: number | null;
  min_players?: number | null;
  max_players?: number | null;
  min_age?: number | null;
  complexity?: number | null;
  play_time_minutes?: number | null;
}

/** 展示用资料：静态库字段 + 后台可维护字段 */
type DisplayGame = GameDetail & Partial<LiveGameFields>;

export default function GameDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { ask, modal } = useExternalConfirm();

  const game = useMemo(() => getGameByIdOrSlug(id ?? ''), [id]);
  const similar = useMemo(() => (game ? getSimilarGames(game, 4) : []), [game]);
  const [activeImage, setActiveImage] = useState(0);
  const [wish, setWish] = useState<'want' | 'played' | 'owned' | null>(null);
  /** 收藏记录 id：取消收藏时需要；未登录或未收藏时为 null */
  const [wishId, setWishId] = useState<number | null>(null);
  /** 图片灯箱：{ 图片集合, 当前下标 }，null 表示关闭 */
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  /** 「更多」弹窗：查看全部玩家实拍 / 全部教学视频 */
  const [photosOpen, setPhotosOpen] = useState(false);
  const [videosOpen, setVideosOpen] = useState(false);
  /** 「写下评测」弹窗 + 本站真实评测列表 */
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState<number>(8);
  const [reviewText, setReviewText] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  /** 评测图片（待发布，最多 9 张） */
  const [reviewFiles, setReviewFiles] = useState<File[]>([]);
  const [reviews, setReviews] = useState<SiteReview[]>([]);
  /** 只有「写了文字内容」的才算评测；右侧直接打分（content 为空）不在这里重复展示 */
  const writtenReviews = reviews.filter((r) => Boolean(r.content && r.content.trim()));
  /** 评测互动：展开的回复面板 / 已加载的评论 / 回复输入框 */
  const [replyOpenId, setReplyOpenId] = useState<number | null>(null);
  const [commentsMap, setCommentsMap] = useState<Record<number, ReviewComment[]>>({});
  const [replyText, setReplyText] = useState('');
  const [replySubmitting, setReplySubmitting] = useState(false);
  /** 规则书翻页：null 关闭；数字为当前页下标 */
  const [rulePage, setRulePage] = useState<number | null>(null);
  /** 库内规则书（后台登记，含 PDF 与图片包）；为空时回落到静态规则书索引 */
  const [liveBooks, setLiveBooks] = useState<AdminRuleBook[]>([]);
  /** 当前翻阅的规则书：null=用静态索引，否则是库内规则书 */
  const [activeBook, setActiveBook] = useState<AdminRuleBook | null>(null);

  // ── 玩家评分（来自本站真实评测聚合） ──
  const token = useAuthStore((s) => s.token);
  const isLoggedIn = Boolean(token);
  const [rating, setRating] = useState<{ avg_rating: number; rating_count: number } | null>(null);
  const [ratingLoading, setRatingLoading] = useState(true);
  const [myRating, setMyRating] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 后端库里的实时资料（管理员可在后台修改）。
   * 静态库只作为首屏兜底；接口返回后以其为准，保证后台编辑能真实生效。
   */
  const [live, setLive] = useState<LiveGameFields | null>(null);
  const { message } = AntApp.useApp();

  /** 展示用资料：静态库为底，接口字段非空时覆盖 */
  const g = useMemo<DisplayGame | null>(() => {
    if (!game) return null;
    if (!live) return game;
    const merged: DisplayGame = { ...game };
    for (const [k, v] of Object.entries(live)) {
      if (v !== null && v !== undefined && v !== '') {
        (merged as unknown as Record<string, unknown>)[k] = v;
      }
    }
    return merged;
  }, [game, live]);

  /** BGG 条目链接：优先用存档链接，缺失时按 BGG ID 生成（URL 规则确定） */
  const bggUrl = useMemo(() => {
    if (!g) return '';
    if (g.bgg_url) return g.bgg_url;
    return g.bgg_id ? `https://boardgamegeek.com/boardgame/${g.bgg_id}` : '';
  }, [g]);

  // 收藏状态：登录后从账号真实读取（不再只是本地 state，刷新/换设备都在）
  useEffect(() => {
    if (!isLoggedIn || !game) {
      setWish(null);
      setWishId(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { data } = await client.get<
          { id: number; game_id: number; status: 'want' | 'played' | 'owned' }[]
        >('/collections');
        if (!alive) return;
        const hit = data.find((c) => c.game_id === game.id);
        setWish(hit ? hit.status : null);
        setWishId(hit ? hit.id : null);
      } catch {
        /* 读取失败保持未收藏态，不打断浏览 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [isLoggedIn, game?.id]);

  /** 点击收藏三态：已登录则真实落库（再次点击同一项＝取消） */
  const toggleWish = async (status: 'want' | 'played' | 'owned') => {
    if (!game) return;
    if (!isLoggedIn) {
      message.warning('登录后才能把收藏同步到账号');
      return;
    }
    try {
      if (wish === status && wishId) {
        await client.delete(`/collections/${wishId}`);
        setWish(null);
        setWishId(null);
        message.success('已取消收藏');
      } else {
        const { data } = await client.post<{ id: number; status: string }>('/collections', {
          game_id: game.id,
          status,
        });
        setWish(status);
        setWishId(data.id);
        message.success(`已标记为「${WISH_LABEL[status]}」`);
      }
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof detail === 'string' ? detail : '操作失败，请稍后重试');
    }
  };

  useEffect(() => {
    if (!game) return;
    // 记入本机「浏览历史」（带时间戳，供侧栏与个人中心管理与展示；本机数据，无需登录）
    pushRecentEntry(game.id);
    let alive = true;
    setRatingLoading(true);
    (async () => {
      try {
        const { data } = await client.get(`/games/${game.id}`);
        if (!alive) return;
        setRating({ avg_rating: data.avg_rating ?? 0, rating_count: data.rating_count ?? 0 });
        // 后台可维护字段以库内实时值为准（管理员改完前台立即生效）
        setLive(data as LiveGameFields);
      } catch {
        if (alive) setRating(null);
      } finally {
        if (alive) setRatingLoading(false);
      }
    })();
    (async () => {
      if (!token) return;
      try {
        const { data } = await client.get('/reviews/summary', { params: { game_id: game.id } });
        if (alive && data?.my_rating != null) setMyRating(data.my_rating);
      } catch {
        /* 未登录或无评分时静默忽略 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [game?.id, token]);

  const submitRating = async (value: number) => {
    if (!game || submitting) return;
    setSubmitting(true);
    try {
      await client.post('/reviews', { game_id: game.id, rating: value });
      message.success(`已评分 ${value} / 10`);
      const { data } = await client.get(`/games/${game.id}`);
      setRating({ avg_rating: data.avg_rating ?? 0, rating_count: data.rating_count ?? 0 });
    } catch {
      message.error('评分提交失败，请重试');
      setMyRating(null);
    } finally {
      setSubmitting(false);
    }
  };

  /** 本站真实评测列表：随游戏切换重新拉取 */
  useEffect(() => {
    if (!game) return;
    let alive = true;
    client
      .get<SiteReview[]>('/reviews', { params: { game_id: game.id, limit: 50 } })
      .then(({ data }) => {
        if (alive && Array.isArray(data)) setReviews(data);
      })
      .catch(() => {
        /* 接口异常时列表留空，不补假数据 */
      });
    return () => {
      alive = false;
    };
  }, [game?.id]);

  if (!game) {
    return (
      <div style={pageContainerStyle}>
        <Empty description="没有找到这款桌游" style={{ margin: '80px 0' }}>
          <BackButton label="返回桌游库" fallback="/games" />
        </Empty>
      </div>
    );
  }

  /** 守卫之后 game 必非空，界面统一读 view（静态库 + 后台实时值合并） */
  const view: DisplayGame = g ?? game;

  // 头图区：只使用官方宣传图（盒装封面等），不放玩家实拍
  const gallery: GameImage[] = game.official_images?.length
    ? game.official_images
    : game.cover_image
      ? [{ src: game.cover_image, caption: '官方盒装封面' }]
      : [];
  // 游戏图集区：只放玩家真实游玩照片
  const playerPhotos: GameImage[] = game.player_images?.length ? game.player_images : game.images;

  const current: GameImage | undefined = gallery[activeImage];
  const total = gallery.length;

  const toLightboxItems = (imgs: GameImage[]): LightboxItem[] =>
    imgs.map((im) => ({
      src: im.src,
      caption: im.caption,
      credit: im.uploader ? `摄影 ${im.uploader}` : undefined,
    }));

  /** 游戏图集默认只展示 5 张，其余通过右上角「更多」弹窗查看 */
  const PHOTO_PREVIEW = 5;
  const shownPhotos = playerPhotos.slice(0, PHOTO_PREVIEW);

  /** 教学视频默认只展示 5 个，其余通过「查看全部」展开 */
  const VIDEO_PREVIEW = 5;
  const sortedVideos = useMemo(
    () => [...game.videos].sort((a, b) => b.views - a.views),
    [game.videos],
  );
  const shownVideos = sortedVideos.slice(0, VIDEO_PREVIEW);

  /** 发表评测：评分 + 正文，写入本站真实评测表 */
  const submitReview = async () => {
    if (!game) return;
    if (!isLoggedIn) {
      navigate('/login');
      return;
    }
    if (reviewText.trim().length < 5) {
      message.warning('评测正文至少写 5 个字，不能只打分');
      return;
    }
    setReviewSubmitting(true);
    try {
      const { data: created } = await client.post<SiteReview>('/reviews', {
        game_id: game.id,
        rating: reviewRating,
        content: reviewText.trim(),
      });
      // 选了图片就单独上传到这条评测（后端限制累计 9 张）
      if (reviewFiles.length) {
        const fd = new FormData();
        reviewFiles.forEach((f) => fd.append('files', f));
        try {
          await client.post(`/reviews/${created.id}/images`, fd);
        } catch {
          message.warning('评测已发布，但图片上传失败（最多 9 张）');
        }
      }
      message.success('评测已发布');
      setReviewOpen(false);
      setReviewText('');
      setReviewFiles([]);
      const [{ data: list }, { data: detail }] = await Promise.all([
        client.get<SiteReview[]>('/reviews', { params: { game_id: game.id, limit: 50 } }),
        client.get(`/games/${game.id}`),
      ]);
      if (Array.isArray(list)) setReviews(list);
      setRating({ avg_rating: detail.avg_rating ?? 0, rating_count: detail.rating_count ?? 0 });
      setMyRating(reviewRating);
    } catch {
      message.error('发布失败，请重试');
    } finally {
      setReviewSubmitting(false);
    }
  };

  /** 点赞 / 取消点赞（切换） */
  const toggleReviewLike = async (r: SiteReview) => {
    if (!isLoggedIn) {
      navigate('/login');
      return;
    }
    try {
      const { data } = await client.post<{ like_count: number; liked: boolean }>(
        `/reviews/${r.id}/like`,
      );
      setReviews((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, like_count: data.like_count, liked: data.liked } : x)),
      );
    } catch {
      message.error('操作失败，请重试');
    }
  };

  /** 展开 / 收起某条评测的回复区，并懒加载已有评论 */
  const toggleReplyPanel = async (r: SiteReview) => {
    if (!isLoggedIn) {
      navigate('/login');
      return;
    }
    if (replyOpenId === r.id) {
      setReplyOpenId(null);
      return;
    }
    setReplyOpenId(r.id);
    setReplyText('');
    if (!commentsMap[r.id]) {
      try {
        const { data } = await client.get<ReviewComment[]>(`/reviews/${r.id}/comments`);
        setCommentsMap((prev) => ({ ...prev, [r.id]: data }));
      } catch {
        /* 忽略，回复区仍可正常发表 */
      }
    }
  };

  /** 发表回复 */
  const submitReply = async (r: SiteReview) => {
    const text = replyText.trim();
    if (!text) {
      message.warning('回复内容不能为空');
      return;
    }
    setReplySubmitting(true);
    try {
      const { data } = await client.post<ReviewComment>(`/reviews/${r.id}/comments`, { content: text });
      setCommentsMap((prev) => ({ ...prev, [r.id]: [...(prev[r.id] ?? []), data] }));
      setReviews((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, comment_count: (x.comment_count ?? 0) + 1 } : x)),
      );
      setReplyText('');
      message.success('回复已发布');
    } catch {
      message.error('发布失败，请重试');
    } finally {
      setReplySubmitting(false);
    }
  };

  /** 规则书：优先用后台登记的库内规则书（PDF / 图片包），没有再回落静态索引 */
  const ruleBook = ruleBooks[game.slug] ?? null;
  const bookList = liveBooks.length > 0 ? liveBooks : [];

  useEffect(() => {
    if (!game?.id) return;
    let alive = true;
    void fetchPublicRuleBooks(game.id).then((rows) => {
      if (alive) setLiveBooks(rows);
    });
    return () => {
      alive = false;
    };
  }, [game?.id]);

  /** 当前翻阅对象：库内规则书或静态索引，统一成 {title, pages, isPdf} */
  const viewing = activeBook
    ? {
        title: activeBook.title,
        pages: (activeBook.pages ?? []).map((p) => `${activeBook.url}/${p}`),
        isPdf: activeBook.file_type === 'pdf',
        url: activeBook.url,
      }
    : ruleBook
      ? { title: ruleBook.title, pages: ruleBook.pages, isPdf: false, url: '' }
      : null;

  /** 规则书翻页支持左右方向键 */
  useEffect(() => {
    if (rulePage === null || !viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setRulePage((p) => (p === null ? p : Math.max(0, p - 1)));
      if (e.key === 'ArrowRight')
        setRulePage((p) => (p === null ? p : Math.min(viewing.pages.length - 1, p + 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rulePage, viewing]);

  return (
    <div style={{ ...pageContainerStyle, paddingBottom: isMobile ? 72 : 24 }} className="tm-page-enter">
      {/* 返回 */}
      <BackButton label="返回" fallback="/games" style={{ marginBottom: 12 }} />

      {/* ── 主信息区 ── */}
      <div
        style={{
          background: '#fff',
          borderRadius: 20,
          padding: isMobile ? 16 : 24,
          boxShadow: '0 2px 8px rgba(17,24,39,.06)',
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 420px) minmax(0, 1fr)',
          gap: isMobile ? 20 : 30,
          marginBottom: 18,
        }}
      >
        {/* 图集 */}
        <div>
          {/* 头图：整块区域可点击放大（button 保证键盘可达 + 光标语义） */}
          <button
            type="button"
            aria-label={`放大查看 ${game.name} 的官方宣传图（${current?.caption ?? ''}）`}
            onClick={() => setLightbox({ items: toLightboxItems(gallery), index: activeImage })}
            style={{
              position: 'relative',
              display: 'block',
              width: '100%',
              padding: 0,
              border: 'none',
              background: '#f2f3f5',
              borderRadius: 16,
              overflow: 'hidden',
              aspectRatio: '4 / 3',
              cursor: 'zoom-in',
              fontFamily: 'inherit',
            }}
          >
            {current ? (
              <img
                key={current.src}
                src={current.src}
                alt={`${game.name} 官方宣传图：${current.caption}`}
                className="tm-img"
                decoding="async"
                draggable={false}
                onError={(e) => {
                  // 图片加载失败时降级为占位块，避免出现破图留白
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
              />
            ) : null}
            {!current && (
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--tm-text-tertiary)',
                  fontSize: 13,
                }}
              >
                暂无该桌游图片
              </span>
            )}
            {/* 放大角标 */}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 26,
                background: 'rgba(17,24,39,.36)',
                opacity: 0,
                transition: 'opacity .18s ease',
                cursor: 'zoom-in',
              }}
              className="hero-zoom-mask"
            >
              <ZoomInOutlined />
            </span>
            {total > 1 && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  right: 10,
                  bottom: 10,
                  background: 'rgba(17,24,39,.62)',
                  color: '#fff',
                  fontSize: 12,
                  padding: '2px 10px',
                  borderRadius: 999,
                  backdropFilter: 'blur(4px)',
                }}
              >
                {activeImage + 1} / {total}
              </span>
            )}
          </button>

          {/* 缩略图 */}
          {total > 1 && (
            <div className="tm-scroll-x" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {gallery.map((img, i) => (
                <button
                  key={img.src}
                  aria-label={`查看第 ${i + 1} 张图片：${img.caption}`}
                  aria-current={i === activeImage}
                  className="tm-press"
                  onClick={() => setActiveImage(i)}
                  style={{
                    border: i === activeImage ? '2px solid var(--tm-action)' : '2px solid transparent',
                    borderRadius: 10,
                    padding: 0,
                    cursor: 'pointer',
                    background: 'transparent',
                    flexShrink: 0,
                    lineHeight: 0,
                  }}
                >
                  <img
                    src={img.src}
                    alt=""
                    loading="lazy"
                    style={{
                      width: 74,
                      height: 56,
                      objectFit: 'cover',
                      borderRadius: 8,
                      display: 'block',
                    }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 基础信息 */}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: '0 0 4px', fontSize: isMobile ? 23 : 28, fontWeight: 800, lineHeight: 1.3 }}>
            {game.name}
            <span
              style={{
                fontSize: 15,
                color: 'var(--tm-text-tertiary)',
                fontWeight: 400,
                marginLeft: 10,
              }}
            >
              {game.name_en}
            </span>
          </h1>

          <Space size={6} wrap style={{ marginTop: 6 }}>
            {game.categories.map((c) => (
              <span key={c} style={chipTint}>
                {c}
              </span>
            ))}
            {game.mechanics.slice(0, 4).map((m) => (
              <span key={m} style={chipPlain}>
                {m}
              </span>
            ))}
          </Space>

          {/* 关键参数 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))',
              gap: 10,
              marginTop: 16,
            }}
          >
            <FactItem
              icon={<TeamOutlined />}
              label="支持人数"
              value={
                view.min_players != null && view.max_players != null
                  ? `${view.min_players}-${view.max_players} 人`
                  : '暂无数据'
              }
            />
            <FactItem icon={<ClockCircleOutlined />} label="单局时长" value={view.play_time_text ?? '暂无数据'} />
            <FactItem
              icon={<UserOutlined />}
              label="适合年龄"
              value={view.min_age != null ? `${view.min_age} 岁以上` : '暂无数据'}
            />
            <FactItem
              icon={<CompassOutlined />}
              label="发行年份"
              value={view.year_published != null ? String(view.year_published) : '暂无数据'}
            />
            <FactItem
              icon={<IdcardOutlined />}
              label="设计师"
              value={view.designers?.length ? view.designers.slice(0, 2).join('、') : '暂无数据'}
            />
          </div>

          {bggUrl ? (
            <div style={{ marginTop: 8 }}>
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto', fontSize: 12.5 }}
                onClick={() => ask(bggUrl, 'BoardGameGeek 桌游条目')}
              >
                <LinkOutlined /> 前往 BGG 查看该桌游条目
              </Button>
            </div>
          ) : null}

          <Divider style={{ margin: '16px 0 14px' }} />

          <div style={{ fontSize: 13, color: 'var(--tm-text-secondary)', marginBottom: 6 }}>游戏简介</div>
          <p style={{ color: '#374151', fontSize: 14, lineHeight: 1.8, margin: 0 }}>{view.description}</p>

          {/* 收藏三态 */}
          <Space size={10} wrap style={{ marginTop: 18 }} role="group" aria-label="收藏与操作">
            <Button
              type={wish === 'want' ? 'primary' : 'default'}
              icon={<HeartOutlined />}
              onClick={() => void toggleWish('want')}
              aria-pressed={wish === 'want'}
            >
              想玩
            </Button>
            <Button
              type={wish === 'played' ? 'primary' : 'default'}
              icon={<CheckCircleOutlined />}
              onClick={() => void toggleWish('played')}
              aria-pressed={wish === 'played'}
            >
              玩过
            </Button>
            <Button
              type={wish === 'owned' ? 'primary' : 'default'}
              icon={<StarOutlined />}
              onClick={() => void toggleWish('owned')}
              aria-pressed={wish === 'owned'}
            >
              拥有
            </Button>
            <Button icon={<RobotOutlined />} onClick={() => navigate(`/ai?game=${game.id}`)}>
              问 AI 规则
            </Button>
          </Space>

          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
            {wish
              ? `已同步到账号：${WISH_LABEL[wish]}`
              : isLoggedIn
                ? '点击上方按钮即可收藏到你的账号'
                : '登录后可同步收藏到账号'}
          </div>

          {/* 溯源 */}
          <details style={{ marginTop: 14 }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--tm-text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <SafetyCertificateOutlined /> 本页数据来源（{game.sources.length} 条，逐条可核对，无估算值）
            </summary>
            <ul
              style={{
                margin: '8px 0 0',
                paddingLeft: 18,
                fontSize: 12,
                lineHeight: 1.9,
                color: 'var(--tm-text-secondary)',
              }}
            >
              {game.sources.map((s) => (
                <li key={s.url + s.label}>
                  {s.label}：
                  <button onClick={() => ask(s.url, s.label)} style={{ ...linkBtn, fontSize: 12 }}>
                    {s.url}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      {/* ── 详细参数 + 数据说明 ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 300px',
          gap: 18,
          marginBottom: 18,
        }}
      >
        <SectionCard title="详细参数">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
            }}
          >
            <InfoItem label="设计师" value={game.designers.join('、') || '—'} />
            <InfoItem label="出版社" value={game.publishers.join('、') || '—'} />
            <InfoItem label="插画师" value={game.artists.join('、') || '—'} />
            <InfoItem label="发行年份" value={game.year_published != null ? String(game.year_published) : '暂无数据'} />
            <InfoItem label="支持人数" value={formatPlayers(game)} />
            <InfoItem label="单局时长" value={formatPlayTime(game)} />
            <InfoItem label="适合年龄" value={formatAge(game)} />
            <InfoItem label="BGG 编号" value={game.bgg_id != null ? `#${game.bgg_id}` : '该桌游非 BGG 来源'} />
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--tm-text-secondary)', marginBottom: 8 }}>游戏机制</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {game.mechanics.map((m) => (
                <span key={m} style={chipPlain}>
                  {m}
                </span>
              ))}
            </div>
          </div>

          {game.honors.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--tm-text-secondary)', marginBottom: 8 }}>
                获奖与提名记录（{game.honors.length} 条，原文来自 BGG）
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  fontSize: 12.5,
                  lineHeight: 1.9,
                  color: '#4b5563',
                  maxHeight: 190,
                  overflowY: 'auto',
                }}
              >
                {game.honors.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </div>
          )}
        </SectionCard>

        <SectionCard title="玩家评分">
          {ratingLoading ? (
            <div style={{ padding: 12 }}>
              <Skeleton active paragraph={{ rows: 3 }} title={false} />
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 800,
                  lineHeight: 1,
                  color: rating && rating.rating_count > 0 ? 'var(--tm-rating)' : 'var(--tm-text-tertiary)',
                }}
              >
                {rating && rating.rating_count > 0 ? rating.avg_rating.toFixed(2) : '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--tm-text-secondary)', marginTop: 8 }}>
                {rating && rating.rating_count > 0
                  ? `满分 10 分 · ${rating.rating_count} 位玩家参与评分`
                  : '还没有玩家评分，来做第一个'}
              </div>

              {/* 自己的评分 */}
              {isLoggedIn && (
                <div
                  style={{
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: '1px solid var(--tm-border)',
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--tm-text-secondary)', marginBottom: 8 }}>
                    {myRating !== null ? `你评过 ${myRating} 分，可修改` : '为这款桌游打分'}
                  </div>
                  <Rate
                    count={10}
                    value={myRating ?? 0}
                    onChange={async (v) => {
                      setMyRating(v);
                      await submitRating(v);
                    }}
                    style={{ fontSize: 16 }}
                  />
                </div>
              )}

              <div
                style={{
                  marginTop: 14,
                  padding: '10px 12px',
                  background: '#fafbfc',
                  borderRadius: 10,
                  fontSize: 12,
                  color: 'var(--tm-text-secondary)',
                  textAlign: 'left',
                  lineHeight: 1.7,
                }}
              >
                <InfoCircleOutlined style={{ color: 'var(--tm-info)', marginRight: 6 }} />
                评分完全来自本站玩家提交的真实评价，排行榜也按这份评分排序，不使用任何外部或估算分数。
              </div>

              {!isLoggedIn && (
                <Button
                  type="primary"
                  block
                  style={{ marginTop: 12 }}
                  onClick={() => navigate('/login')}
                >
                  登录后参与评分
                </Button>
              )}
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── 游戏图集：只放玩家真实游玩照片 ── */}
      <SectionCard
        title="游戏图集"
        extra={
          playerPhotos.length > 0 ? (
            <Button type="link" size="small" onClick={() => setPhotosOpen(true)} style={{ padding: 0 }}>
              更多
            </Button>
          ) : undefined
        }
        style={{ marginBottom: 18 }}
      >
        {playerPhotos.length === 0 ? (
          <Empty description="暂无玩家上传的实拍照片" />
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(210px, 1fr))',
                gap: 12,
              }}
            >
              {shownPhotos.map((img, i) => (
                <button
                  key={img.src}
                  onClick={() =>
                    setLightbox({ items: toLightboxItems(playerPhotos), index: i })
                  }
                  aria-label={`放大查看实拍照片：${img.caption}`}
                  className="tm-card"
                  style={{
                    border: 'none',
                    padding: 0,
                    background: '#fff',
                    borderRadius: 12,
                    overflow: 'hidden',
                    cursor: 'zoom-in',
                    textAlign: 'left',
                    boxShadow: '0 2px 8px rgba(17,24,39,.06)',
                  }}
                >
                  <div style={{ position: 'relative' }}>
                    <img
                      src={img.src}
                      alt={img.caption}
                      loading="lazy"
                      decoding="async"
                      className="tm-img tm-zoom"
                      style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', display: 'block' }}
                    />
                    <span
                      style={{
                        position: 'absolute',
                        right: 7,
                        bottom: 7,
                        background: 'rgba(17,24,39,.55)',
                        color: '#fff',
                        borderRadius: 999,
                        width: 26,
                        height: 26,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                      }}
                    >
                      <ZoomInOutlined />
                    </span>
                  </div>
                  <div
                    className="tm-clamp-2"
                    style={{ padding: '9px 11px 11px', fontSize: 12, color: 'var(--tm-text-secondary)', lineHeight: 1.6 }}
                  >
                    {img.caption}
                    {img.uploader && (
                      <span style={{ color: 'var(--tm-text-tertiary)' }}> · 摄影 {img.uploader}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>

          </>
        )}
      </SectionCard>

      {/* ── 教学视频 ── */}
      <SectionCard
        title="教学视频"
        extra={
          game.videos.length > 0 ? (
            <Button type="link" size="small" onClick={() => setVideosOpen(true)} style={{ padding: 0 }}>
              更多
            </Button>
          ) : undefined
        }
        style={{ marginBottom: 18 }}
      >
        {game.videos.length === 0 ? (
          <Empty description="暂无已核验的教学视频" />
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(246px, 1fr))',
                gap: 16,
              }}
            >
              {shownVideos.map((v) => (
                <VideoCard key={v.bvid} video={v} onOpen={() => ask(v.url, v.title, v.author)} />
              ))}
            </div>

          </>
        )}
      </SectionCard>

      {/* ── 同类推荐 ── */}
      <SectionCard
        title="同类桌游推荐"
        extra={
          <span style={{ fontSize: 12, color: 'var(--tm-text-secondary)' }}>
            依据类型、机制、人数区间与时长自动匹配
          </span>
        }
        style={{ marginBottom: 18 }}
      >
        {similar.length === 0 ? (
          <Empty description="暂无同类游戏" />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(272px, 1fr))',
              gap: 14,
            }}
          >
            {similar.map(({ game: g, reasons }) => (
              <div
                key={g.id}
                role="link"
                tabIndex={0}
                onClick={() => navigate(`/games/${g.slug}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/games/${g.slug}`);
                  }
                }}
                aria-label={`查看同类桌游 ${g.name}`}
                className="tm-card"
                style={{
                  display: 'flex',
                  gap: 12,
                  background: '#fff',
                  border: '1px solid var(--tm-border)',
                  borderRadius: 14,
                  padding: 12,
                  cursor: 'pointer',
                }}
              >
                <img
                  src={g.cover_image}
                  alt={`${g.name} 盒装封面`}
                  loading="lazy"
                  decoding="async"
                  style={{
                    width: 62,
                    height: 78,
                    objectFit: 'cover',
                    borderRadius: 10,
                    flexShrink: 0,
                    background: '#f2f3f5',
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="tm-clamp-1" style={{ fontSize: 15, fontWeight: 700 }}>
                    {g.name}
                  </div>
                  <div className="tm-clamp-1" style={{ fontSize: 12, color: 'var(--tm-text-secondary)', marginTop: 2 }}>
                    {formatPlayers(g)} · {formatPlayTime(g)}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {reasons.slice(0, 2).map((r) => (
                      <span
                        key={r}
                        style={{
                          fontSize: 11,
                          color: 'var(--tm-link)',
                          background: 'var(--tm-tint)',
                          borderRadius: 7,
                          padding: '1px 8px',
                          lineHeight: '18px',
                        }}
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── 游戏规则：官方规则书入口（真实来源，不做本地虚构） ── */}
      <SectionCard
        title="游戏规则"
        extra={
          <Button type="link" size="small" onClick={() => navigate(`/ai?game=${game.id}`)} style={{ padding: 0 }}>
            问 AI 规则
          </Button>
        }
        style={{ marginBottom: 18 }}
      >
        {bookList.length === 0 && !ruleBook ? (
          <Empty description="这款桌游暂未收录规则书" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* 库内规则书（后台登记，可能是 PDF 或图片包） */}
            {bookList.map((b) => {
              const cover = b.pages?.length ? `${b.url}/${b.pages[0]}` : '';
              return (
                <div
                  key={b.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    border: '1px solid var(--tm-border)',
                    borderRadius: 12,
                    padding: 14,
                    background: '#fafbfc',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveBook(b);
                      setRulePage(0);
                    }}
                    aria-label={`打开规则书 ${b.title}`}
                    className="tm-card"
                    style={{
                      border: 'none',
                      padding: 0,
                      background: '#fff',
                      borderRadius: 10,
                      overflow: 'hidden',
                      flexShrink: 0,
                      cursor: 'zoom-in',
                      boxShadow: '0 1px 4px rgba(17,24,39,.08)',
                      width: 96,
                      height: 128,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {cover ? (
                      <img
                        src={cover}
                        alt={`${game.name} 规则书封面`}
                        style={{ display: 'block', width: 96, height: 128, objectFit: 'cover' }}
                      />
                    ) : (
                      <FilePdfOutlined style={{ fontSize: 34, color: 'var(--tm-action)' }} />
                    )}
                  </button>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 4,
                        flexWrap: 'wrap',
                      }}
                    >
                      <ReadOutlined style={{ color: 'var(--tm-action)' }} />
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{b.title}</span>
                      {b.page_count ? (
                        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                          共 {b.page_count} 页
                        </Tag>
                      ) : null}
                      {b.is_official ? (
                        <Tag color="green" style={{ marginInlineEnd: 0 }}>
                          官方
                        </Tag>
                      ) : (
                        <Tag style={{ marginInlineEnd: 0 }}>玩家翻译</Tag>
                      )}
                      {b.chunk_count ? (
                        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                          已收录 {b.chunk_count} 条规则
                        </Tag>
                      ) : null}
                    </div>
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => {
                        setActiveBook(b);
                        setRulePage(0);
                      }}
                      style={{ marginTop: 10 }}
                    >
                      在线翻阅
                    </Button>
                  </div>
                </div>
              );
            })}

            {/* 静态索引兜底：库内还没登记时，仍展示站内已收录的扫描页 */}
            {bookList.length === 0 && ruleBook ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  border: '1px solid var(--tm-border)',
                  borderRadius: 12,
                  padding: 14,
                  background: '#fafbfc',
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveBook(null);
                    setRulePage(0);
                  }}
                  aria-label="打开规则书"
                  className="tm-card"
                  style={{
                    border: 'none',
                    padding: 0,
                    background: '#fff',
                    borderRadius: 10,
                    overflow: 'hidden',
                    flexShrink: 0,
                    cursor: 'zoom-in',
                    boxShadow: '0 1px 4px rgba(17,24,39,.08)',
                  }}
                >
                  <img
                    src={ruleBook.pages[0]}
                    alt={`${game.name} 规则书封面`}
                    style={{ display: 'block', width: 96, height: 128, objectFit: 'cover' }}
                  />
                </button>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <ReadOutlined style={{ color: 'var(--tm-action)' }} />
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{ruleBook.title}</span>
                    <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                      共 {ruleBook.pages.length} 页
                    </Tag>
                  </div>
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => {
                      setActiveBook(null);
                      setRulePage(0);
                    }}
                    style={{ marginTop: 10 }}
                  >
                    在线翻阅
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>

      {/* ── 评测 ── */}
      <SectionCard
        title="玩家评测"
        extra={
          <span style={{ fontSize: 12, color: 'var(--tm-text-secondary)' }}>共 {writtenReviews.length} 条本站真实评测</span>
        }
        style={{ marginBottom: 18 }}
      >
        {writtenReviews.length === 0 ? (
          <Empty
            description={<span style={{ color: 'var(--tm-text-secondary)' }}>还没有评测，来做第一个</span>}
            style={{ padding: '20px 0' }}
          >
            <Button type="primary" onClick={() => (isLoggedIn ? setReviewOpen(true) : navigate('/login'))}>
              写下你的评测
            </Button>
          </Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Button type="primary" onClick={() => (isLoggedIn ? setReviewOpen(true) : navigate('/login'))}>
                写下你的评测
              </Button>
            </div>
            {writtenReviews.map((r) => (
              <div
                key={r.id}
                style={{
                  border: '1px solid var(--tm-border)',
                  borderRadius: 12,
                  padding: '13px 15px',
                  background: '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{r.username}</span>
                  <Tag color="volcano">{r.rating} / 10</Tag>
                  <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
                    {new Date(r.created_at).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
                  {r.content || '（这位玩家只打了分，没有写内容）'}
                </div>

                {/* 评测图片：最多 9 张，点击放大 */}
                {r.images && r.images.length > 0 && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                      gap: 8,
                      marginTop: 10,
                      maxWidth: 460,
                    }}
                  >
                    {r.images.map((src, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() =>
                          setLightbox({
                            items: r.images!.map((s) => ({ src: s, caption: '' })),
                            index: i,
                          })
                        }
                        style={{
                          border: 'none',
                          padding: 0,
                          background: '#fff',
                          borderRadius: 8,
                          overflow: 'hidden',
                          cursor: 'zoom-in',
                          aspectRatio: '1 / 1',
                        }}
                      >
                        <img
                          src={src}
                          alt=""
                          loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      </button>
                    ))}
                  </div>
                )}

                {/* 操作栏：点赞 / 回复 / 更多 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 12,
                    borderTop: '1px solid var(--tm-border)',
                    paddingTop: 10,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleReviewLike(r)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 13,
                      color: r.liked ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
                      padding: '2px 8px',
                      borderRadius: 8,
                    }}
                  >
                    <HeartOutlined />
                    点赞{r.like_count ? ` ${r.like_count}` : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleReplyPanel(r)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 13,
                      color: replyOpenId === r.id ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
                      padding: '2px 8px',
                      borderRadius: 8,
                    }}
                  >
                    <CommentOutlined />
                    回复{r.comment_count ? ` ${r.comment_count}` : ''}
                  </button>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'like', label: r.liked ? '取消点赞' : '点赞', icon: <HeartOutlined /> },
                        { key: 'reply', label: '回复', icon: <CommentOutlined /> },
                        { type: 'divider' },
                        { key: 'report', label: '举报', icon: <EllipsisOutlined />, danger: true },
                      ],
                      onClick: ({ key }) => {
                        if (key === 'like') toggleReviewLike(r);
                        else if (key === 'reply') toggleReplyPanel(r);
                        else if (key === 'report') message.info('已收到举报，我们会尽快核实');
                      },
                    }}
                  >
                    <button
                      type="button"
                      aria-label="更多操作"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--tm-text-tertiary)',
                        fontSize: 15,
                        padding: '2px 8px',
                        borderRadius: 8,
                        marginLeft: 'auto',
                      }}
                    >
                      <EllipsisOutlined />
                    </button>
                  </Dropdown>
                </div>

                {/* 回复区：已加载的评论 + 发表框 */}
                {replyOpenId === r.id && (
                  <div style={{ marginTop: 10, background: '#fafbfc', borderRadius: 10, padding: 10 }}>
                    {(commentsMap[r.id] ?? []).length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginBottom: 8 }}>
                        还没有回复，来抢沙发
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                        {(commentsMap[r.id] ?? []).map((c) => (
                          <div
                            key={c.id}
                            style={{
                              fontSize: 13,
                              color: '#374151',
                              background: '#fff',
                              border: '1px solid var(--tm-border)',
                              borderRadius: 8,
                              padding: '8px 10px',
                              lineHeight: 1.7,
                            }}
                          >
                            <span style={{ fontWeight: 700, marginRight: 6, color: 'var(--tm-text-primary)' }}>
                              {c.username || '匿名玩家'}
                            </span>
                            <span style={{ color: 'var(--tm-text-tertiary)', fontSize: 11, marginLeft: 4 }}>
                              {new Date(c.created_at).toLocaleDateString('zh-CN')}
                            </span>
                            <div style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.content}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <Input.TextArea
                      rows={2}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="回复这条评测……"
                      maxLength={500}
                    />
                    <div style={{ textAlign: 'right', marginTop: 8 }}>
                      <Button type="primary" size="small" loading={replySubmitting} onClick={() => submitReply(r)}>
                        发表回复
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* 「更多」弹窗：全部玩家实拍 */}
      <Modal
        open={photosOpen}
        title={`游戏图集 · 全部 ${playerPhotos.length} 张`}
        onCancel={() => setPhotosOpen(false)}
        footer={null}
        width={900}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 12,
            maxHeight: '62vh',
            overflowY: 'auto',
            paddingRight: 4,
          }}
        >
          {playerPhotos.map((img, i) => (
            <button
              key={img.src}
              onClick={() => setLightbox({ items: toLightboxItems(playerPhotos), index: i })}
              className="tm-card"
              style={{
                border: 'none',
                padding: 0,
                background: '#fff',
                borderRadius: 12,
                overflow: 'hidden',
                cursor: 'zoom-in',
                textAlign: 'left',
                boxShadow: '0 2px 8px rgba(17,24,39,.06)',
              }}
            >
              <img
                src={img.src}
                alt={img.caption}
                loading="lazy"
                style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', display: 'block' }}
              />
              <div
                className="tm-clamp-2"
                style={{ padding: '8px 10px 10px', fontSize: 12, color: 'var(--tm-text-secondary)', lineHeight: 1.6 }}
              >
                {img.caption}
                {img.uploader && <span style={{ color: 'var(--tm-text-tertiary)' }}> · 摄影 {img.uploader}</span>}
              </div>
            </button>
          ))}
        </div>
      </Modal>

      {/* 「更多」弹窗：全部教学视频 */}
      <Modal
        open={videosOpen}
        title={`教学视频 · 全部 ${game.videos.length} 个`}
        onCancel={() => setVideosOpen(false)}
        footer={null}
        width={900}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(246px, 1fr))',
            gap: 16,
            maxHeight: '62vh',
            overflowY: 'auto',
            paddingRight: 4,
          }}
        >
          {sortedVideos.map((v) => (
            <VideoCard key={v.bvid} video={v} onOpen={() => ask(v.url, v.title, v.author)} />
          ))}
        </div>
      </Modal>

      {/* 规则书翻页阅读 */}
      <Modal
        open={rulePage !== null && !!viewing}
        title={viewing ? `${game.name} · ${viewing.title}` : ''}
        onCancel={() => setRulePage(null)}
        footer={null}
        width="min(96vw, 1280px)"
        centered
        styles={{ body: { padding: 12 } }}
      >
        {viewing && rulePage !== null ? (
          viewing.isPdf ? (
            <iframe
              src={viewing.url}
              title={`${game.name} 规则书`}
              style={{ width: '100%', height: '82vh', border: 'none' }}
            />
          ) : (
          <div style={{ textAlign: 'center' }}>
            <img
              src={viewing.pages[rulePage]}
              alt={`${game.name} 规则书第 ${rulePage + 1} 页`}
              style={{ maxWidth: '100%', maxHeight: '86vh', objectFit: 'contain', cursor: 'zoom-in' }}
              onClick={() =>
                setLightbox({
                  items: viewing.pages.map((p, i) => ({
                    src: p,
                    caption: `规则书第 ${i + 1} 页`,
                  })),
                  index: rulePage,
                })
              }
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 18,
                marginTop: 14,
              }}
            >
              <Button
                icon={<LeftOutlined />}
                disabled={rulePage === 0}
                onClick={() => setRulePage((p) => (p === null ? p : Math.max(0, p - 1)))}
              >
                上一页
              </Button>
              <span style={{ fontSize: 13.5, color: 'var(--tm-text-secondary)' }}>
                第 {rulePage + 1} / {viewing.pages.length} 页
              </span>
              <Button
                disabled={rulePage === viewing.pages.length - 1}
                onClick={() => setRulePage((p) => (p === null ? p : Math.min(viewing.pages.length - 1, p + 1)))}
              >
                下一页
                <RightOutlined />
              </Button>
            </div>
          </div>
          )
        ) : null}
      </Modal>

      {/* 发表评测 */}
      <Modal
        open={reviewOpen}
        title={`写下你对《${game.name}》的评测`}
        okText="发布评测"
        cancelText="取消"
        confirmLoading={reviewSubmitting}
        onCancel={() => {
          setReviewOpen(false);
          setReviewFiles([]);
        }}
        onOk={submitReview}
      >
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--tm-text-secondary)', marginBottom: 6 }}>你的评分（1-10）</div>
          <Rate count={10} value={reviewRating} onChange={setReviewRating} />
        </div>
        <Input.TextArea
          rows={5}
          value={reviewText}
          onChange={(e) => setReviewText(e.target.value)}
          placeholder="聊聊规则手感、开局节奏、重开意愿……真实体验最有参考价值"
          maxLength={1000}
          showCount
        />
        {/* 评测图片：最多 9 张，发布前可预览、删除 */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--tm-text-secondary)', marginBottom: 8 }}>
            上传图片（选填，最多 9 张）
          </div>
          <Upload
            accept="image/*"
            multiple
            showUploadList={false}
            beforeUpload={(file) => {
              if (reviewFiles.length >= 9) {
                message.warning('最多上传 9 张图片');
                return false;
              }
              setReviewFiles((prev) => [...prev, file as unknown as File]);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} disabled={reviewFiles.length >= 9}>
              选择图片（{reviewFiles.length}/9）
            </Button>
          </Upload>
          {reviewFiles.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {reviewFiles.map((f, i) => (
                <div
                  key={i}
                  style={{
                    position: 'relative',
                    width: 64,
                    height: 64,
                    borderRadius: 8,
                    overflow: 'hidden',
                    border: '1px solid var(--tm-border)',
                  }}
                >
                  <img
                    src={URL.createObjectURL(f)}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <button
                    type="button"
                    aria-label="移除图片"
                    onClick={() => setReviewFiles((prev) => prev.filter((_, j) => j !== i))}
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(17,24,39,.7)',
                      color: '#fff',
                      fontSize: 11,
                      lineHeight: '18px',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <div
        style={{
          textAlign: 'center',
          color: 'var(--tm-text-tertiary)',
          fontSize: 12,
          marginTop: 18,
          lineHeight: 1.8,
        }}
      >
        <LinkOutlined style={{ marginRight: 6 }} />
        游戏资料来自 BoardGameGeek 公开数据并逐条标注来源；评分与评测待接入真实数据后开放
        <div style={{ marginTop: 6 }}>
          <button onClick={() => ask(game.sources[0].url, `${game.name} 的 BGG 主页`)} style={linkBtn}>
            在 BGG 查看这款游戏
          </button>
        </div>
      </div>

      {modal}

      {/* 图片灯箱：点击任意图片放大查看 */}
      <Lightbox
        items={lightbox?.items ?? []}
        index={lightbox ? lightbox.index : null}
        onClose={() => setLightbox(null)}
        onIndexChange={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : prev))}
      />
    </div>
  );
}

/* ── 样式片段 ── */
const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--tm-link)',
  cursor: 'pointer',
  padding: 0,
  fontSize: 'inherit',
  fontFamily: 'inherit',
  textDecoration: 'underline',
};

const chipTint: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 12,
  lineHeight: '23px',
  padding: '0 10px',
  borderRadius: 8,
  background: 'var(--tm-tint)',
  color: 'var(--tm-link)',
};

const chipPlain: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 12,
  lineHeight: '23px',
  padding: '0 10px',
  borderRadius: 8,
  background: '#f3f4f6',
  color: 'var(--tm-text-secondary)',
};

/* ── 子组件 ── */

function FactItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div
      style={{
        background: '#fafbfc',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <span style={{ color: 'var(--tm-action)', fontSize: 15 }} aria-hidden>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--tm-text-tertiary)', fontSize: 11 }}>{label}</div>
        <div style={{ color: 'var(--tm-text-primary)', fontSize: 13, fontWeight: 600, marginTop: 1 }}>
          {value}
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#fafbfc', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ color: 'var(--tm-text-tertiary)', fontSize: 12 }}>{label}</div>
      <div
        className="tm-clamp-2"
        style={{ color: 'var(--tm-text-primary)', fontSize: 13.5, fontWeight: 600, marginTop: 2, lineHeight: 1.5 }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  extra,
  children,
  style,
}: {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section
      style={{
        background: '#fff',
        borderRadius: 16,
        padding: '20px 22px 24px',
        boxShadow: '0 2px 8px rgba(17,24,39,.06)',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

function VideoCard({ video, onOpen }: { video: TeachingVideo; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-label={`在哔哩哔哩观看：${video.title}（UP 主 ${video.author}）`}
      className="tm-card"
      style={{
        border: '1px solid var(--tm-border)',
        background: '#fff',
        borderRadius: 14,
        padding: 0,
        overflow: 'hidden',
        cursor: 'pointer',
        textAlign: 'left',
        boxShadow: '0 2px 8px rgba(17,24,39,.06)',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#f2f3f5', overflow: 'hidden' }}>
        <img
          src={video.cover}
          alt=""
          loading="lazy"
          decoding="async"
          className="tm-img"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 40,
            textShadow: '0 2px 10px rgba(0,0,0,.45)',
            opacity: 0.92,
          }}
        >
          <PlayCircleFilled />
        </span>
        <span
          style={{
            position: 'absolute',
            right: 8,
            bottom: 8,
            background: 'rgba(17,24,39,.68)',
            color: '#fff',
            fontSize: 12,
            padding: '1px 7px',
            borderRadius: 6,
          }}
        >
          {formatDuration(video.durationSeconds)}
        </span>
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        <div
          className="tm-clamp-2"
          style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5, minHeight: 42 }}
          title={video.title}
        >
          {video.title}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 8,
            fontSize: 12,
            color: 'var(--tm-text-secondary)',
          }}
        >
          <span className="tm-clamp-1" style={{ maxWidth: '68%' }}>
            UP：{video.author}
          </span>
          <span style={{ flexShrink: 0 }}>
            <span style={{ color: 'var(--tm-rating)', fontWeight: 600 }}>{formatViews(video.views)}</span> 播放
          </span>
        </div>
        <Tooltip title="点击后先确认，再在新标签页打开 B 站">
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--tm-link)' }}>
            在 B 站观看 · {video.bvid}
          </div>
        </Tooltip>
      </div>
    </button>
  );
}
