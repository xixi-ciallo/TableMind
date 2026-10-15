import { useEffect, useMemo, useState } from 'react';
import client from '../../shared/api/client';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { formatPlayTime, formatPlayers, gameLibrary } from '../../shared/gameLibrary';
import { useIsMobile } from '../../shared/useIsMobile';
import MobileHome from './MobileHome';

/**
 * 首页（TapTap 桌面首页版式）：
 *   1. 顶部一排 3 张为一组，共 9 组；每次刷新页面重新随机分组，不自动计时轮换
 *   2. 频道胶囊：全部由库内真实标签生成，右侧箭头可横向移动
 *   3. 中部分区：按当前标签随机取 9 款桌游（刷新页面重新随机），评分块放在白色信息区
 *   4. 底部「查看更多」跳转到桌游库对应筛选
 * 全部数据来自真实收录的桌游，不做任何虚构推荐位。
 */

/** 顶部一排同时展示 3 张 */
const BANNER_SLOTS = 3;
/** 顶部一共 9 组 */
const BANNER_GROUPS = 9;
/** 中部分区每个标签展示 9 款 */
const GRID_SIZE = 9;
/** 频道胶囊里出现的真实标签数量 */
const TAG_LIMIT = 30;
/** 默认频道 key */
const ALL_KEY = 'all';

type Game = (typeof gameLibrary)[number];

/** 洗牌：每次挂载重新随机，所以刷新页面就会换一批 */
function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 顶部九组：随机抽 27 款有封面的桌游，每 3 款一组 */
function pickBannerGroups(): Game[][] {
  const covered = gameLibrary.filter((g) => g.cover_image);
  const pool = shuffle(covered);
  const need = BANNER_GROUPS * BANNER_SLOTS;
  const filled = pool.length >= need ? pool : Array.from({ length: need }, (_, i) => pool[i % pool.length]);
  return Array.from({ length: BANNER_GROUPS }, (_, i) =>
    filled.slice(i * BANNER_SLOTS, i * BANNER_SLOTS + BANNER_SLOTS),
  );
}

/** 库内出现频次最高的真实标签 */
function topTags(): string[] {
  const counter = new Map<string, number>();
  for (const g of gameLibrary) {
    for (const c of g.categories) if (c) counter.set(c, (counter.get(c) ?? 0) + 1);
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TAG_LIMIT)
    .map(([c]) => c);
}

export default function HomePage() {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileHome />;
  return <DesktopHome />;
}

function DesktopHome() {
  const navigate = useNavigate();

  /** 顶部九组只在挂载时洗一次牌；刷新页面重新随机，切页不重复抽 */
  const [groups] = useState<Game[][]>(pickBannerGroups);
  const [group, setGroup] = useState(0);
  const slide = groups[group] ?? [];

  /** 频道：默认「全部」+ 库内真实标签 */
  const tags = useMemo(() => topTags(), []);
  const [activeTag, setActiveTag] = useState<string>(ALL_KEY);
  const channelLabel = activeTag === ALL_KEY ? '全部' : activeTag;
  const channelCount = useMemo(
    () =>
      activeTag === ALL_KEY
        ? gameLibrary.length
        : gameLibrary.filter((g) => g.categories.includes(activeTag)).length,
    [activeTag],
  );

  /** 中部分区内容：按当前标签随机取 9 款 */
  const gridItems = useMemo(() => {
    const src = activeTag === ALL_KEY ? gameLibrary : gameLibrary.filter((g) => g.categories.includes(activeTag));
    return shuffle(src).slice(0, GRID_SIZE);
  }, [activeTag]);

  /**
   * 真实评分：只拉一次列表接口建立 id → 均分映射。
   * 拿不到的就保持空态（显示 —），绝不用估算值补位。
   */
  const [ratings, setRatings] = useState<Record<number, { avg: number }>>({});
  useEffect(() => {
    let alive = true;
    client
      .get<{ id: number; avg_rating: number | null }[]>('/games', { params: { page_size: 100 } })
      .then(({ data }) => {
        if (!alive) return;
        const map: Record<number, { avg: number }> = {};
        for (const g of data) {
          if (g.avg_rating != null) map[g.id] = { avg: g.avg_rating };
        }
        setRatings(map);
      })
      .catch(() => {
        /* 接口不可用时保持空态，不补假数据 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const scoreOf = (g: Game) => {
    const rt = ratings[g.id];
    return rt ? rt.avg.toFixed(1) : '—';
  };

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }} className="tm-page-enter">
      {/* ── 1. 顶部推荐：3 张一组，共 9 组，手动翻组不自动轮播 ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 16,
        }}
      >
        {slide.map((g) => (
          <article
            key={g.id}
            onClick={() => navigate(`/games/${g.slug}`)}
            className="tm-press"
            style={{
              position: 'relative',
              borderRadius: 16,
              overflow: 'hidden',
              cursor: 'pointer',
              aspectRatio: '5 / 4',
              background: '#0f1115',
              boxShadow: '0 8px 22px rgba(17,24,39,.12)',
            }}
          >
            <img
              src={g.cover_image}
              alt={`${g.name} 盒装封面`}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <div
              aria-hidden
              style={{
                position: 'absolute',
                inset: 'auto 0 0 0',
                height: '66%',
                background:
                  'linear-gradient(to top, rgba(8,10,14,.94) 0%, rgba(8,10,14,.58) 45%, rgba(8,10,14,0) 100%)',
              }}
            />
            <div style={{ position: 'absolute', inset: 'auto 0 0 0', padding: '0 16px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="tm-clamp-1" style={{ color: '#fff', fontSize: 19, fontWeight: 700 }}>
                    {g.name}
                  </div>
                  <div
                    className="tm-clamp-1"
                    style={{ color: 'rgba(255,255,255,.84)', fontSize: 13, marginTop: 5 }}
                  >
                    {formatPlayers(g)} · {formatPlayTime(g)} · {g.year_published ?? '年份暂无'}
                  </div>
                </div>
                {/* TapTap 式评分块 */}
                <div
                  style={{
                    flexShrink: 0,
                    background: 'rgba(255,255,255,.18)',
                    borderRadius: 10,
                    padding: '7px 11px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: '#fff', fontSize: 11, lineHeight: 1.25 }}>TapMind</div>
                  <div
                    style={{
                      color: '#00e0c0',
                      fontSize: 22,
                      fontWeight: 800,
                      lineHeight: 1.15,
                      textShadow: '0 1px 6px rgba(0,0,0,.5)',
                    }}
                  >
                    {scoreOf(g)}
                  </div>
                </div>
              </div>
              {g.description && (
                <div
                  className="tm-clamp-1"
                  style={{ color: 'rgba(255,255,255,.74)', fontSize: 12.5, marginTop: 9 }}
                >
                  {g.description}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {/* 分组控制条：左箭头 + 9 段圆点 + 右箭头（无计时轮换） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          marginTop: 18,
        }}
      >
        <span style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)', marginRight: 2 }}>
          第 {group + 1} / {BANNER_GROUPS} 组
        </span>
        <button
          aria-label="上一组"
          onClick={() => setGroup((i) => Math.max(i - 1, 0))}
          className="tm-press"
          style={circleCtl(group <= 0)}
        >
          <LeftOutlined style={{ fontSize: 12, color: '#6b7280' }} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {Array.from({ length: BANNER_GROUPS }).map((_, i) => (
            <button
              key={i}
              aria-label={`看第 ${i + 1} 组`}
              onClick={() => setGroup(i)}
              style={{
                border: 'none',
                width: i === group ? 20 : 7,
                height: 7,
                borderRadius: 999,
                background: i === group ? 'var(--tm-action)' : '#d1d5db',
                cursor: 'pointer',
                padding: 0,
                transition: 'width .25s var(--tm-ease-out)',
              }}
            />
          ))}
        </div>
        <button
          aria-label="下一组"
          onClick={() => setGroup((i) => Math.min(i + 1, BANNER_GROUPS - 1))}
          className="tm-press"
          style={circleCtl(group >= BANNER_GROUPS - 1)}
        >
          <RightOutlined style={{ fontSize: 12, color: '#6b7280' }} />
        </button>
      </div>

      {/* ── 2. 频道胶囊：只用库内真实标签；左右按钮放在滚动条外面，永远看得见 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          margin: '34px 0 18px',
        }}
      >
        <div
          className="tm-scroll-x"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            flex: 1,
            minWidth: 0,
          }}
          role="tablist"
          aria-label="内容频道"
        >
        <button
          role="tab"
          aria-selected={activeTag === ALL_KEY}
          onClick={() => setActiveTag(ALL_KEY)}
          className="tm-press"
          style={pillStyle(activeTag === ALL_KEY)}
        >
          {channelLabel === '全部' && (
            <span
              aria-hidden
              style={{ width: 6, height: 6, borderRadius: 999, background: '#fff', opacity: 0.9 }}
            />
          )}
          {channelLabel}
        </button>
        {tags.map((t) => {
          const active = activeTag === t;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTag(t)}
              className="tm-press"
              style={pillStyle(active)}
            >
              {t}
            </button>
          );
        })}
        </div>

        {/* 向左 / 向右两个按钮，负责把标签栏横向移动（固定在胶囊行外侧） */}
        <button
          aria-label="标签栏向左移动"
          onClick={() => {
            const row = document.querySelector('[role="tablist"]');
            if (row) row.scrollBy({ left: -360, behavior: 'smooth' });
          }}
          className="tm-press"
          style={arrowCtl}
        >
          <LeftOutlined style={{ fontSize: 11, color: '#9ca3af' }} />
        </button>
        <button
          aria-label="标签栏向右移动"
          onClick={() => {
            const row = document.querySelector('[role="tablist"]');
            if (row) row.scrollBy({ left: 360, behavior: 'smooth' });
          }}
          className="tm-press"
          style={{ ...arrowCtl, marginLeft: 4 }}
        >
          <RightOutlined style={{ fontSize: 11, color: '#9ca3af' }} />
        </button>
      </div>

      {/* ── 3. 中部分区：当前标签对应的随机 9 款，评分放在白色信息区 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: 'var(--tm-text-primary)' }}>
          {channelLabel}
        </h2>
        <span style={{ fontSize: 13, color: 'var(--tm-text-tertiary)' }}>
          {channelCount} 款 · 随机展示 9 款
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 14,
        }}
      >
        {gridItems.map((g) => {
          const tagsOfCard = g.categories.slice(0, 3);
          return (
            <article
              key={g.id}
              onClick={() => navigate(`/games/${g.slug}`)}
              className="tm-press"
              style={{
                borderRadius: 16,
                overflow: 'hidden',
                cursor: 'pointer',
                background: '#fff',
                border: '1px solid var(--tm-border)',
                boxShadow: '0 3px 14px rgba(17,24,39,.06)',
                transition: 'transform .2s var(--tm-ease-out), box-shadow .2s var(--tm-ease-out)',
              }}
            >
              {/* 长方形的图框（收小一档） */}
              <div style={{ aspectRatio: '16 / 9', background: '#f2f3f5' }}>
                <img
                  src={g.cover_image}
                  alt={`${g.name} 盒装封面`}
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </div>
              {/* 白色信息区：名称 + 评分块放在一起，评分不再压在图片上 */}
              <div style={{ padding: '13px 15px 15px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                  <div
                    className="tm-clamp-1"
                    style={{ fontSize: 15, fontWeight: 700, flex: 1, color: 'var(--tm-text-primary)' }}
                  >
                    {g.name}
                  </div>
                  <div
                    style={{
                      flexShrink: 0,
                      background: '#f6f7f9',
                      border: '1px solid var(--tm-border)',
                      borderRadius: 9,
                      padding: '3px 8px 4px',
                      textAlign: 'center',
                      minWidth: 50,
                    }}
                  >
                    <div style={{ fontSize: 9.5, color: 'var(--tm-text-tertiary)', lineHeight: 1.3 }}>
                      TapMind
                    </div>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 800,
                        lineHeight: 1.2,
                        color: 'var(--tm-action)',
                      }}
                    >
                      {scoreOf(g)}
                    </div>
                  </div>
                </div>
                <div
                  className="tm-clamp-1"
                  style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)', marginTop: 7 }}
                >
                  {g.name_en ? `${g.name_en} · ` : ''}{formatPlayers(g)} · {formatPlayTime(g)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {tagsOfCard.length ? (
                    tagsOfCard.map((t) => (
                      <span
                        key={t}
                        style={{
                          background: 'var(--tm-tint)',
                          color: 'var(--tm-text-on-tint, #c43715)',
                          fontSize: 12,
                          padding: '3px 9px',
                          borderRadius: 6,
                        }}
                      >
                        {t}
                      </span>
                    ))
                  ) : (
                    <span
                      style={{
                        background: '#f6f7f9',
                        color: 'var(--tm-text-tertiary)',
                        fontSize: 12,
                        padding: '3px 9px',
                        borderRadius: 6,
                      }}
                    >
                      未标注
                    </span>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/* ── 4. 查看更多：跳到桌游库对应筛选 ── */}
      <div style={{ marginTop: 26, display: 'flex', justifyContent: 'center' }}>
        <button
          onClick={() =>
            navigate(activeTag === ALL_KEY ? '/games' : `/games?category=${encodeURIComponent(activeTag)}`)
          }
          className="tm-press"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            border: '1px solid var(--tm-border-strong)',
            background: '#fff',
            borderRadius: 10,
            padding: '10px 22px',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--tm-text-primary)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          查看更多「{channelLabel}」桌游
          <RightOutlined style={{ fontSize: 12, color: 'var(--tm-action)' }} />
        </button>
      </div>
    </div>
  );
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    border: 'none',
    background: active ? '#1a1a1a' : '#f4f5f7',
    color: active ? '#fff' : '#4b5563',
    fontWeight: active ? 600 : 500,
    fontSize: 14,
    padding: active ? '9px 16px 9px 13px' : '9px 16px',
    borderRadius: 999,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
}

function circleCtl(disabled: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: '1px solid var(--tm-border-strong)',
    background: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontFamily: 'inherit',
  };
}

const arrowCtl: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  border: '1px solid var(--tm-border-strong)',
  background: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
  padding: 0,
};
