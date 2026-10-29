import { useEffect, useState } from 'react';
import { FireFilled, GlobalOutlined, StarFilled } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  bggGeekRanking,
  type BggGeekItem,
} from '../../shared/bggGeekRanking';
import { getGameByIdOrSlug } from '../../shared/gameLibrary';
import client from '../../shared/api/client';
import { useIsMobile } from '../../shared/useIsMobile';

/** 每个榜取多少行（实际 fetched 行数，列表内部滚动查看其余） */
const SHOW = 20;
/** 滚动区高度 ≈ 8 行（每行约 73px：封面 54 + 上下内边距 18 + 行间距） */
const SCROLL_HEIGHT = 584;

/** 从静态库取真实的出版年与分类（拿不到就返回空，不编造） */
function metaOf(idOrSlug: number | string): { year: number | null; tags: string[] } {
  const g = getGameByIdOrSlug(idOrSlug);
  if (!g) return { year: null, tags: [] };
  return { year: g.year_published ?? null, tags: (g.categories ?? []).slice(0, 2) };
}

/* ── 数据类型 ── */

interface SiteRow {
  rank: number;
  game_id: number;
  name: string;
  name_en: string | null;
  cover_image: string | null;
  avg_rating: number;
  rating_count: number;
  year_published: number | null;
}

interface PopularRow {
  rank: number;
  game_id: number;
  name: string;
  name_en: string | null;
  cover_image: string | null;
  want_count: number;
  played_count: number;
}

/* ── 名次数字：TapTap 式浅灰斜体，所有名次统一大小（前三名不放大） ── */

function RankNum({ rank }: { rank: number }) {
  return (
    <span
      style={{
        width: 56,
        flexShrink: 0,
        textAlign: 'center',
        lineHeight: 1,
        fontSize: 17,
        fontWeight: 700,
        color: '#9ca3af',
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontStyle: 'italic',
        alignSelf: 'center',
      }}
    >
      {rank}
    </span>
  );
}

/** ★ 评分行内展示（TapTap 是「★分值 + 标签」第二行，非右侧徽标） */
function ScoreInline({ value, strong }: { value: string; strong?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        color: strong ? 'var(--tm-action)' : 'var(--tm-text-tertiary)',
        fontWeight: 800,
        fontSize: strong ? 13.5 : 12.5,
      }}
    >
      <StarFilled style={{ fontSize: strong ? 11 : 10 }} />
      {value}
    </span>
  );
}

/** 副行：左侧数值（评分 / 热度）+ 「年份 / 标签 / 标签」。
 *  reserve=true 时即使没有数值也保留占位空隙（版式与有数据时一致）；
 *  缺失的段直接不渲染，不编造。 */
function MetaLine({
  score,
  reserve,
  year,
  tags,
}: {
  score?: React.ReactNode;
  reserve?: boolean;
  year: number | null;
  tags: string[];
}) {
  const parts: string[] = [];
  if (year) parts.push(String(year));
  parts.push(...tags.filter(Boolean));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 5, overflow: 'hidden' }}>
      {/* 评分 / 热度占位：无数据时保留空位；nowrap 防止窄行时「热度」等标签竖排折行 */}
      <span
        style={{
          display: 'inline-flex',
          minWidth: !score && reserve ? 46 : undefined,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {score}
      </span>
      {parts.length > 0 && (
        <span
          className="tm-clamp-1"
          style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}
        >
          {parts.join(' / ')}
        </span>
      )}
    </div>
  );
}

/** 右侧「查看」按钮：默认隐藏，hover 该行才显示 */
function ViewBtn() {
  return (
    <span
      className="tm-rank-btn"
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        padding: '5px 12px',
        borderRadius: 999,
        background: 'var(--tm-tint)',
        color: 'var(--tm-action)',
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      查看
    </span>
  );
}

/* ── 通用榜单行 ── */

function RowMain({
  rank,
  cover,
  name,
  score,
  reserve,
  year,
  tags,
  onClick,
}: {
  rank: number;
  cover: string | null;
  name: string;
  score?: React.ReactNode;
  reserve?: boolean;
  year: number | null;
  tags: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tm-press tm-nav-item tm-rank-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12, /* 统一间距，保证封面严格左对齐 */
        width: '100%',
        border: 'none',
        borderRadius: 14,
        padding: '9px 10px',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <RankNum rank={rank} />
      <img
        src={cover ?? ''}
        alt=""
        loading="lazy"
        style={{
          width: 54,
          height: 54,
          objectFit: 'cover',
          borderRadius: 11,
          flexShrink: 0,
          background: 'var(--tm-surface-page)',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="tm-clamp-1"
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--tm-text-primary)',
          }}
        >
          {name}
        </div>
        <MetaLine score={score} reserve={reserve} year={year} tags={tags} />
      </div>
      <ViewBtn />
    </button>
  );
}

/** 榜单卡片外壳（白卡 + 「」标题 + 内部独立滚动区 + 底部数据说明） */
function BoardCard({
  icon,
  title,
  note,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: '#fff',
        border: '1px solid var(--tm-border)',
        borderRadius: 16,
        padding: '14px 12px 10px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 8px 10px',
          fontSize: 16,
          fontWeight: 800,
          color: 'var(--tm-action)',
        }}
      >
        {icon}「{title}」
      </div>
      {/* 榜单各自独立滚动：初始露出约 10 行，向下滚动查看其余 */}
      <div
        className="tm-rank-scroll"
        style={{
          maxHeight: SCROLL_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          paddingRight: 4,
        }}
      >
        {children}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--tm-border)',
          marginTop: 8,
          padding: '9px 8px 2px',
          textAlign: 'center',
          fontSize: 11.5,
          color: 'var(--tm-text-tertiary)',
        }}
      >
        {note}
      </div>
    </section>
  );
}

function CardSkeleton() {
  return (
    <div style={{ padding: '8px 8px 20px' }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 11, marginBottom: 14, alignItems: 'center' }}>
          <div className="tm-skeleton" style={{ width: 26, height: 26, borderRadius: 6 }} />
          <div className="tm-skeleton" style={{ width: 46, height: 46, borderRadius: 10 }} />
          <div style={{ flex: 1 }}>
            <div className="tm-skeleton" style={{ height: 13, width: '72%', borderRadius: 6 }} />
            <div className="tm-skeleton" style={{ height: 10, width: '45%', borderRadius: 6, marginTop: 8 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RankingsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  /** 本站评分榜（后端真实聚合；fallback=评分数不足，按库内顺序展示） */
  const [site, setSite] = useState<SiteRow[] | null>(null);
  const [siteFallback, setSiteFallback] = useState(false);
  /** 热门榜（想玩 + 玩过 真实标记聚合；fallback=尚无标记） */
  const [hot, setHot] = useState<PopularRow[] | null>(null);
  const [hotFallback, setHotFallback] = useState(false);

  useEffect(() => {
    let alive = true;
    client
      .get<{ rows: SiteRow[]; fallback?: boolean }>('/rankings', {
        /* 本站评分榜取满 20 名：评分人数门槛放宽到 2（当前 47 款收录、20 款有 2+ 条评分） */
        params: { board: 'overall', limit: SHOW, min_ratings: 2 },
      })
      .then(({ data }) => {
        if (!alive) return;
        setSite(Array.isArray(data?.rows) ? data.rows : []);
        setSiteFallback(Boolean(data?.fallback));
      })
      .catch(() => {
        if (alive) setSite([]);
      });
    client
      .get<{ rows: PopularRow[]; fallback?: boolean }>('/rankings/popular', {
        params: { limit: SHOW },
      })
      .then(({ data }) => {
        if (!alive) return;
        setHot(Array.isArray(data?.rows) ? data.rows : []);
        setHotFallback(Boolean(data?.fallback));
      })
      .catch(() => {
        if (alive) setHot([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** BGG 极客榜：只保留本站已收录的作品，并按它们的 BGG 名次重新连续编号 1..n */
  const bggList: Array<BggGeekItem & { rank: number }> = bggGeekRanking
    /* slug 存在还不够，必须能在本站游戏库里真正找到，避免把站外作品排进来 */
    .filter(
      (it): it is BggGeekItem & { slug: string } =>
        it.slug !== null && Boolean(getGameByIdOrSlug(it.slug)),
    )
    .sort((a, b) => a.position - b.position)
    .slice(0, SHOW)
    .map((it, i) => ({ ...it, rank: i + 1 }));

  return (
    <div
      className="tm-page-enter"
      /* 整个页面固定：占满视口高度、不整体滚动；三张榜单卡各自内部独立滚动 */
      style={{
        maxWidth: 1440,
        margin: '0 auto',
        width: '100%',
        height: 'calc(100vh - 64px)',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        padding: '18px 24px 20px',
      }}
    >
      {/* 页头：只留标题 */}
      <header style={{ flexShrink: 0, marginBottom: 14 }}>
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? 22 : 28,
            fontWeight: 800,
            color: 'var(--tm-text-primary)',
            letterSpacing: '-.3px',
          }}
        >
          排行榜
        </h1>
      </header>

      {/* 三榜并排（TapTap 榜单页版式；移动端纵向堆叠，每张卡各自独立滚动） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
          gap: 20,
          alignItems: 'start',
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* ── 榜一：本站评分榜 ── */}
        <BoardCard
          icon={<StarFilled style={{ fontSize: 15 }} />}
          title="本站评分榜"
          note={
            siteFallback
              ? '暂未收到玩家评分，按库内收录顺序展示'
              : '玩家真实评分，客观反映口碑（少于 2 人评分暂不入榜）'
          }
        >
          {site === null && <CardSkeleton />}
          {site !== null &&
            site.map((r) => {
              const meta = metaOf(r.game_id);
              return (
                <RowMain
                  key={r.game_id}
                  rank={r.rank}
                  cover={r.cover_image}
                  name={r.name}
                  /* 有真实评分才显示；无评分时保留占位空隙 */
                  score={
                    r.rating_count > 0 ? (
                      <ScoreInline value={r.avg_rating.toFixed(1)} strong />
                    ) : undefined
                  }
                  reserve
                  year={meta.year}
                  tags={meta.tags}
                  onClick={() => navigate(`/games/${r.game_id}`)}
                />
              );
            })}
        </BoardCard>

        {/* ── 榜二：BGG 极客榜（只排本站已收录作品） ── */}
        <BoardCard
          icon={<GlobalOutlined style={{ fontSize: 15 }} />}
          title="BGG 极客榜"
          note={`仅展示本站已收录的 ${bggList.length} 款 · 数据来源 BoardGameGeek`}
        >
          {bggList.map((it) => {
            const meta = it.slug ? metaOf(it.slug) : { year: it.year_published, tags: [] };
            return (
              <RowMain
                key={it.bgg_id}
                rank={it.rank}
                cover={it.thumb}
                name={it.name_zh ?? it.name}
                score={<ScoreInline value={it.geek_rating.toFixed(2)} strong />}
                year={meta.year}
                /* 小字 = 年份 / 该桌游自己的分类标签（不放 BGG 名次） */
                tags={meta.tags}
                onClick={() => navigate(`/games/${it.slug}`)}
              />
            );
          })}
        </BoardCard>

        {/* ── 榜三：热门榜 ── */}
        <BoardCard
          icon={<FireFilled style={{ fontSize: 15 }} />}
          title="热门榜"
          note={
            hotFallback
              ? '暂无论你想玩或玩过标记，按库内收录顺序展示'
              : '由玩家「想玩 / 玩过」标记实时生成'
          }
        >
          {hot === null && <CardSkeleton />}
          {hot !== null &&
            hot.map((r) => {
              const meta = metaOf(r.game_id);
              const heat = r.want_count + r.played_count;
              return (
                <RowMain
                  key={r.game_id}
                  rank={r.rank}
                  cover={r.cover_image}
                  name={r.name}
                  /* 第三榜用热度代替评分：🔥 + 数值（不写「热度」二字）；无任何标记时保留占位，不编造 */
                  score={
                    heat > 0 ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'baseline',
                          gap: 3,
                          color: 'var(--tm-action)',
                          fontWeight: 800,
                          fontSize: 15,
                        }}
                      >
                        <FireFilled style={{ fontSize: 12 }} />
                        {heat}
                      </span>
                    ) : undefined
                  }
                  reserve
                  year={meta.year}
                  tags={meta.tags}
                  onClick={() => navigate(`/games/${r.game_id}`)}
                />
              );
            })}
        </BoardCard>
      </div>
    </div>
  );
}
