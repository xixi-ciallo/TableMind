import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CrownOutlined,
  PictureOutlined,
  PlayCircleFilled,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import GameCard from '../../shared/GameCard';
import { bggRanking, type BggRankItem } from '../../shared/bggRanking';
import {
  allCategories,
  formatDuration,
  formatPlayTime,
  formatPlayers,
  formatViews,
  gameLibrary,
  getAwardRankings,
} from '../../shared/gameLibrary';

/** 移动端首页金刚区（与桌面端同一套口径，点击直达对应分类的桌游库） */
const QUICK_ENTRIES = [
  { label: '策略', hint: '烧脑对决', cat: '策略' },
  { label: '派对', hint: '热闹开黑', cat: '派对' },
  { label: '合作', hint: '一起过关', cat: '合作' },
  { label: '家庭', hint: '亲子同乐', cat: '家庭' },
  { label: '卡牌', hint: '手牌博弈', cat: '卡牌' },
  { label: '冒险', hint: '探索征途', cat: '冒险' },
  { label: '竞速', hint: '抢先冲线', cat: '竞速' },
  { label: '儿童', hint: '轻松入门', cat: '儿童' },
];

const ROTATE_MS = 5200;

/**
 * 移动端首页：沿用桌面端首页的内容结构（编辑推荐轮播 → 搜索 → 金刚区 →
 * BGG 热度榜 → 热门桌游 → 获奖榜 / 玩家实拍 → 教学视频 → 全部分类），
 * 只把栅格换成移动端常见的「两列网格 + 横滑」排版。数据全部来自真实数据层。
 */
export default function MobileHome() {
  const navigate = useNavigate();

  const [kw, setKw] = useState('');
  /** 编辑推荐轮播下标（与桌面端一致，纯前端计时，数据仍是真实收录的桌游） */
  const [banner, setBanner] = useState(0);

  const picks = useMemo(() => [...gameLibrary].filter((g) => g.cover_image).slice(0, 5), []);

  useEffect(() => {
    if (picks.length <= 1) return;
    const t = window.setInterval(() => {
      setBanner((i) => (i + 1) % picks.length);
    }, ROTATE_MS);
    return () => window.clearInterval(t);
  }, [picks.length]);

  const awardTop = useMemo(() => getAwardRankings().slice(0, 3), []);
  const hotTop = useMemo(() => bggRanking.slice(0, 8), []);
  const videoPicks = useMemo(
    () =>
      gameLibrary
        .filter((g) => g.videos.length > 0)
        .flatMap((g) => g.videos.map((v) => ({ game: g, video: v })))
        .sort((a, b) => b.video.views - a.video.views)
        .slice(0, 4),
    [],
  );
  /** 玩家实拍精选：取每款收录桌游的第一张玩家实拍图 */
  const photoPicks = useMemo(
    () => gameLibrary.filter((g) => (g.player_images.length ? g.player_images[0] : null)).slice(0, 4),
    [],
  );

  const submitSearch = () => {
    const q = kw.trim();
    navigate(q ? `/games?q=${encodeURIComponent(q)}` : '/games');
  };

  const current = picks[banner % Math.max(picks.length, 1)];

  return (
    <div style={{ paddingBottom: 20 }} className="tm-page-enter">
      {/* 顶部品牌栏 */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'rgba(255,255,255,.92)',
          backdropFilter: 'saturate(180%) blur(14px)',
          WebkitBackdropFilter: 'saturate(180%) blur(14px)',
          borderBottom: '1px solid var(--tm-border)',
        }}
      >
        <div style={{ padding: '0 16px', height: 54, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/')}
            aria-label="回到首页"
            className="tm-press"
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontFamily: 'inherit',
              fontSize: 19,
              fontWeight: 800,
              color: 'var(--tm-text-primary)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 26,
                height: 26,
                borderRadius: 9,
                background: 'linear-gradient(135deg, var(--tm-brand-light), var(--tm-action))',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 14,
                fontWeight: 800,
              }}
            >
              T
            </span>
            TableMind
          </button>
          <button
            onClick={() => navigate('/games')}
            aria-label="搜索桌游"
            className="tm-press"
            style={{
              marginLeft: 'auto',
              border: 'none',
              width: 34,
              height: 34,
              borderRadius: 999,
              background: '#f3f4f6',
              color: '#4b5563',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
            }}
          >
            <SearchOutlined />
          </button>
        </div>
      </div>

      {/* ── 编辑推荐轮播（桌面端 Banner 位的移动端同构） ── */}
      {current && (
        <div style={{ padding: '14px 16px 0' }}>
          <div
            onClick={() => navigate(`/games/${current.slug}`)}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(`/games/${current.slug}`);
            }}
            className="tm-press"
            style={{
              position: 'relative',
              borderRadius: 18,
              overflow: 'hidden',
              background: 'linear-gradient(122deg, #ff9d7a 0%, var(--tm-brand) 40%, var(--tm-action) 100%)',
              color: '#fff',
              minHeight: 214,
              cursor: 'pointer',
              boxShadow: '0 8px 20px rgba(217,61,26,.18)',
            }}
          >
            <div style={{ position: 'relative', zIndex: 1, padding: '18px 18px 16px' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'rgba(255,255,255,.22)',
                  borderRadius: 999,
                  padding: '4px 12px',
                  fontSize: 11.5,
                  fontWeight: 600,
                }}
              >
                <CrownOutlined /> 编辑推荐 · {banner + 1}/{picks.length}
              </span>
              <div style={{ marginTop: 10, fontSize: 19, fontWeight: 800, lineHeight: 1.35 }}>
                {current.name}
              </div>
              <div
                style={{
                  marginTop: 5,
                  fontSize: 12,
                  color: 'rgba(255,255,255,.92)',
                  lineHeight: 1.7,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                }}
              >
                <span>{formatPlayers(current)}</span>
                <span aria-hidden>·</span>
                <span>{formatPlayTime(current)}</span>
                <span aria-hidden>·</span>
                <span>{current.year_published ?? '年份暂无'}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 13, flexWrap: 'wrap' }}>
                <span
                  style={{
                    border: '1px solid rgba(255,255,255,.85)',
                    borderRadius: 999,
                    padding: '6px 14px',
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  查看详情
                </span>
                <span
                  style={{
                    border: '1px solid rgba(255,255,255,.85)',
                    borderRadius: 999,
                    padding: '6px 14px',
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  问 AI 规则
                </span>
              </div>
            </div>
            {current.cover_image && (
              <img
                src={current.cover_image}
                alt={`${current.name} 盒装封面`}
                loading="lazy"
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  right: 0,
                  bottom: 0,
                  width: 118,
                  height: 118,
                  objectFit: 'cover',
                  borderTopLeftRadius: 16,
                  borderBottomRightRadius: 18,
                  display: 'block',
                }}
              />
            )}
            {/* 轮播圆点 */}
            <div
              style={{
                position: 'absolute',
                left: 18,
                bottom: 12,
                display: 'flex',
                gap: 5,
                zIndex: 2,
              }}
            >
              {picks.map((_, i) => (
                <span
                  key={i}
                  aria-hidden
                  style={{
                    width: i === banner % picks.length ? 16 : 5,
                    height: 5,
                    borderRadius: 999,
                    background: i === banner % picks.length ? '#fff' : 'rgba(255,255,255,.5)',
                    transition: 'width .25s var(--tm-ease-out)',
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 全站搜索 ── */}
      <div style={{ padding: '14px 16px 0' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#fff',
            border: '1px solid var(--tm-border-strong)',
            borderRadius: 999,
            padding: '4px 4px 4px 14px',
            boxShadow: '0 2px 10px rgba(17,24,39,.04)',
          }}
        >
          <SearchOutlined style={{ color: 'var(--tm-text-tertiary)', fontSize: 14 }} />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch();
            }}
            placeholder="搜索桌游名称、英文名或标签"
            aria-label="搜索桌游"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: 13.5,
              color: 'var(--tm-text-primary)',
              padding: '6px 0',
            }}
          />
          <button
            onClick={submitSearch}
            className="tm-press"
            style={{
              border: 'none',
              background: 'var(--tm-action)',
              color: '#fff',
              borderRadius: 999,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            搜索
          </button>
        </div>
      </div>

      {/* ── 金刚区 ── */}
      <div
        className="tm-scroll-x"
        style={{ display: 'flex', gap: 10, padding: '16px 16px 0', overflowX: 'auto' }}
        role="group"
        aria-label="快捷分类入口"
      >
        {QUICK_ENTRIES.map((e, i) => (
          <button
            key={e.label}
            type="button"
            onClick={() => navigate(`/games?category=${encodeURIComponent(e.cat)}`)}
            className="tm-press"
            style={{
              flexShrink: 0,
              border: 'none',
              width: 66,
              background: '#fff',
              borderRadius: 14,
              padding: '10px 4px 9px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'inherit',
              boxShadow: '0 2px 10px rgba(17,24,39,.05)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 40,
                height: 40,
                borderRadius: 13,
                background: `linear-gradient(135deg, ${QUICK_ENTRIES_TINT[i % QUICK_ENTRIES_TINT.length]}, #fff)`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 17,
                fontWeight: 800,
                color: 'var(--tm-action)',
              }}
            >
              {e.label.slice(0, 1)}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tm-text-primary)' }}>
              {e.label}
            </span>
          </button>
        ))}
      </div>

      {/* ── BGG 热度榜 ── */}
      <MobileSection title="BGG 热度榜" sub="BoardGameGeek 官方 Hotness" onMore={() => navigate('/rankings')}>
        <div className="tm-scroll-x" style={{ display: 'flex', gap: 10, padding: '0 16px', overflowX: 'auto' }}>
          {hotTop.map((it, i) => (
            <button
              key={it.bgg_id}
              onClick={() => goBgg(navigate, it)}
              aria-label={`BGG 第 ${i + 1} 名 ${it.name}`}
              className="tm-card tm-card-x"
              style={{
                width: 132,
                flexShrink: 0,
                border: 'none',
                padding: 0,
                background: '#fff',
                borderRadius: 14,
                overflow: 'hidden',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: '0 2px 8px rgba(17,24,39,.06)',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ position: 'relative', aspectRatio: '4 / 3', background: '#f2f3f5', overflow: 'hidden' }}>
                <img
                  src={it.cover ?? ''}
                  alt=""
                  loading="lazy"
                  className="tm-img tm-zoom"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: 6,
                    top: 6,
                    minWidth: 20,
                    height: 20,
                    padding: '0 5px',
                    borderRadius: 7,
                    background: i < 3 ? 'var(--tm-action)' : 'rgba(17,24,39,.62)',
                    color: '#fff',
                    fontSize: 11.5,
                    fontWeight: 800,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {i + 1}
                </span>
              </div>
              <div style={{ padding: '7px 9px 9px' }}>
                <div className="tm-clamp-1" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {it.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--tm-text-tertiary)', marginTop: 3 }}>
                  {it.min_players}-{it.max_players} 人 · {it.play_time_minutes} 分钟
                </div>
              </div>
            </button>
          ))}
        </div>
      </MobileSection>

      {/* ── 热门桌游 ── */}
      <MobileSection title="热门桌游" sub="本站真实收录" onMore={() => navigate('/games')}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 10,
            padding: '0 16px',
          }}
        >
          {gameLibrary.slice(0, 6).map((g) => (
            <GameCard key={g.id} game={g} />
          ))}
        </div>
      </MobileSection>

      {/* ── 获奖榜 + 玩家实拍 ── */}
      <MobileSection title="获奖榜" sub="BGG 官方获奖次数" onMore={() => navigate('/rankings')}>
        <div style={{ display: 'flex', gap: 10, padding: '0 16px' }}>
          {awardTop.map((a, i) => (
            <button
              key={a.game.id}
              onClick={() => navigate(`/games/${a.game.slug}`)}
              aria-label={`第 ${i + 1} 名 ${a.game.name}`}
              className="tm-card tm-card-x"
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                padding: 0,
                background: '#fff',
                borderRadius: 14,
                overflow: 'hidden',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: '0 2px 8px rgba(17,24,39,.06)',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ position: 'relative', aspectRatio: '4 / 3', background: '#f2f3f5', overflow: 'hidden' }}>
                <img
                  src={a.game.cover_image}
                  alt={`${a.game.name} 盒装封面`}
                  loading="lazy"
                  className="tm-img tm-zoom"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: 6,
                    top: 6,
                    width: 21,
                    height: 21,
                    borderRadius: 7,
                    background: i === 0 ? '#d93d1a' : i === 1 ? '#e8763f' : '#c9922f',
                    color: '#fff',
                    fontSize: 11.5,
                    fontWeight: 800,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {i + 1}
                </span>
              </div>
              <div style={{ padding: '7px 8px 9px' }}>
                <div className="tm-clamp-1" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {a.game.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--tm-action)', fontWeight: 700, marginTop: 3 }}>
                  {a.winCount} 项获奖
                </div>
              </div>
            </button>
          ))}
        </div>
      </MobileSection>

      <MobileSection
        title="玩家实拍"
        icon={<PictureOutlined style={{ color: 'var(--tm-action)', fontSize: 13 }} />}
        onMore={() => navigate('/games')}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 10,
            padding: '0 16px',
          }}
        >
          {photoPicks.map((g) => {
            const photo = g.player_images[0];
            return (
              <button
                key={g.id}
                onClick={() => navigate(`/games/${g.slug}`)}
                aria-label={`${g.name} 玩家实拍`}
                className="tm-card tm-card-x"
                style={{
                  border: 'none',
                  padding: 0,
                  background: '#fff',
                  borderRadius: 14,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  textAlign: 'left',
                  boxShadow: '0 2px 8px rgba(17,24,39,.06)',
                  fontFamily: 'inherit',
                }}
              >
                <div style={{ position: 'relative', aspectRatio: '1 / 1', background: '#f2f3f5', overflow: 'hidden' }}>
                  <img
                    src={photo.src}
                    alt={photo.caption ?? `${g.name} 玩家实拍`}
                    loading="lazy"
                    className="tm-img tm-zoom"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </div>
                <div className="tm-clamp-1" style={{ padding: '7px 9px 9px', fontSize: 12, color: 'var(--tm-text-secondary)' }}>
                  {g.name} 玩家实拍
                </div>
              </button>
            );
          })}
        </div>
      </MobileSection>

      {/* ── 教学视频 ── */}
      <MobileSection
        title="教学视频精选"
        sub="哔哩哔哩 · 已核验"
        icon={<PlayCircleFilled style={{ color: 'var(--tm-action)', fontSize: 13 }} />}
        onMore={() => navigate('/games')}
      >
        <div className="tm-scroll-x" style={{ display: 'flex', gap: 10, padding: '0 16px', overflowX: 'auto' }}>
          {videoPicks.map(({ game: g, video: v }) => (
            <button
              key={v.bvid}
              onClick={() => navigate(`/games/${g.slug}`)}
              aria-label={`${g.name} 教学视频：${v.title}`}
              className="tm-card tm-card-x"
              style={{
                width: 210,
                flexShrink: 0,
                border: 'none',
                padding: 0,
                background: '#fff',
                borderRadius: 14,
                overflow: 'hidden',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: '0 2px 8px rgba(17,24,39,.06)',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#f2f3f5', overflow: 'hidden' }}>
                <img
                  src={v.cover}
                  alt=""
                  loading="lazy"
                  className="tm-img tm-zoom"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <span
                  style={{
                    position: 'absolute',
                    right: 6,
                    bottom: 6,
                    background: 'rgba(17,24,39,.68)',
                    color: '#fff',
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 5,
                  }}
                >
                  {formatDuration(v.durationSeconds)}
                </span>
              </div>
              <div style={{ padding: '9px 10px 11px' }}>
                <div className="tm-clamp-2" style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.5, minHeight: 36 }}>
                  {v.title}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11.5,
                    color: 'var(--tm-text-secondary)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span className="tm-clamp-1">{g.name}</span>
                  <span style={{ flexShrink: 0, color: 'var(--tm-rating)', fontWeight: 600 }}>
                    {formatViews(v.views)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </MobileSection>

      {/* ── 全部分类 ── */}
      <MobileSection title="全部分类" onMore={() => navigate('/games')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 16px' }}>
          {allCategories.slice(0, 14).map((c) => (
            <button
              key={c}
              onClick={() => navigate(`/games?category=${encodeURIComponent(c)}`)}
              className="tm-press"
              style={{
                border: '1px solid var(--tm-border-strong)',
                background: '#fff',
                color: 'var(--tm-text-secondary)',
                fontSize: 12.5,
                padding: '6px 14px',
                borderRadius: 999,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </MobileSection>

      <div
        style={{
          margin: '20px 16px 0',
          padding: '13px 14px',
          borderRadius: 14,
          background: '#fff',
          border: '1px solid var(--tm-border)',
          color: 'var(--tm-text-secondary)',
          fontSize: 11.5,
          lineHeight: 1.8,
        }}
      >
        榜单与图片数据来自 BoardGameGeek 公开接口，逐条标注来源；本站不展示任何估算分数。
      </div>
    </div>
  );
}

/** BGG 榜单项 → 本站详情页：收录了就进本站，没收录才提示跳 BGG */
const detailByBggId = new Map<number, string>();
for (const g of gameLibrary) if (g.bgg_id != null) detailByBggId.set(g.bgg_id, g.slug);

function goBgg(navigate: (to: string) => void, it: BggRankItem) {
  const slug = detailByBggId.get(it.bgg_id);
  if (slug) navigate(`/games/${slug}`);
  else window.open(it.url, '_blank', 'noopener,noreferrer');
}

/** 金刚区图标底色（暖色系浅底，逐个轮换） */
const QUICK_ENTRIES_TINT = [
  '#ffe6de',
  '#ffe0e0',
  '#e2f0ff',
  '#e6f7ea',
  '#f3e8ff',
  '#fff3d6',
  '#ffe9f2',
  '#e6f4f6',
];

function MobileSection({
  title,
  sub,
  icon,
  onMore,
  children,
}: {
  title: string;
  sub?: string;
  icon?: React.ReactNode;
  onMore?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: '0 16px',
          marginBottom: 12,
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          {icon}
          <span style={{ fontSize: 16.5, fontWeight: 700 }}>{title}</span>
          {sub && (
            <span className="tm-clamp-1" style={{ fontSize: 11, color: 'var(--tm-text-secondary)' }}>
              {sub}
            </span>
          )}
        </div>
        {onMore && (
          <button
            onClick={onMore}
            className="tm-press"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--tm-link)',
              fontSize: 12,
              cursor: 'pointer',
              padding: '4px 0',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            更多 <RightOutlined style={{ fontSize: 9 }} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
