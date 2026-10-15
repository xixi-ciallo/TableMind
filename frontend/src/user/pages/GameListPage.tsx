import { useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Empty, Segmented } from 'antd';
import {
  AppstoreOutlined,
  DownOutlined,
  PictureOutlined,
  SlidersOutlined,
  SwapOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import GameCard from '../../shared/GameCard';
import {
  allCategories,
  formatAge,
  formatPlayTime,
  formatPlayers,
  gameLibrary,
  type GameDetail,
} from '../../shared/gameLibrary';
import { pageContainerStyle } from '../../shared/theme';
import { useIsMobile } from '../../shared/useIsMobile';

const PAGE_SIZE = 15;
type SortKey = 'hot' | 'newest' | 'oldest' | 'name';
type ViewMode = 'grid' | 'list';

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
  { label: '默认', value: 'hot' },
  { label: '最新发行', value: 'newest' },
  { label: '最早发行', value: 'oldest' },
  { label: '按名称', value: 'name' },
];

/** 玩家人数档位（集石样式：1~13，14+） */
const PLAYER_COUNTS = Array.from({ length: 13 }, (_, i) => i + 1).concat([14]);

/** 人均时长（分钟）档位，与集石列表页一致 */
const DURATION_OPTIONS = [
  { label: '1-5 分钟', min: 0, max: 5 },
  { label: '6-15 分钟', min: 6, max: 15 },
  { label: '16-30 分钟', min: 16, max: 30 },
  { label: '31-60 分钟', min: 31, max: 60 },
  { label: '61-90 分钟', min: 61, max: 90 },
  { label: '91+ 分钟', min: 91, max: Infinity },
];

/** 适合年龄档位（按库内真实 min_age 分布调整） */
const AGE_OPTIONS = [
  { label: '10 岁以下', test: (a: number) => a < 10 },
  { label: '10-13 岁', test: (a: number) => a >= 10 && a <= 13 },
  { label: '14 岁以上', test: (a: number) => a >= 14 },
];

/** 计数：某维度在游戏库中的出现次数，用于给分类/机制排序 */
function countBy(pick: (g: GameDetail) => string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const g of gameLibrary) {
    for (const v of pick(g)) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
}

export default function GameListPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // 支持从首页入口带 ?category=xxx / ?q=关键词 直接进入筛选态
  const [searchParams] = useSearchParams();
  const initialCategory = searchParams.get('category') ?? '';
  const initialKeyword = searchParams.get('q') ?? '';

  const [keyword, setKeyword] = useState(initialKeyword);
  // 所有筛选维度都支持多选（同维度 OR、跨维度 AND）
  const [categories, setCategories] = useState<string[]>(initialCategory ? [initialCategory] : []);
  const [players, setPlayers] = useState<number[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [durations, setDurations] = useState<number[]>([]);
  const [ages, setAges] = useState<number[]>([]);
  const [mechanics, setMechanics] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>('hot');
  const [view, setView] = useState<ViewMode>('grid');
  const [page, setPage] = useState(1);
  /** 筛选面板是否展开（集石底部「快速筛选」可收起） */
  const [panelOpen, setPanelOpen] = useState(true);
  /** 分类/机制是否展示全部 */
  const [allCats, setAllCats] = useState(false);

  // 顶部搜索框跳转到 /games?q=关键词 时，即使已停留在本页也要同步关键词做筛选
  useEffect(() => {
    setKeyword(searchParams.get('q') ?? '');
  }, [searchParams]);

  // 维度取值：全部来自真实游戏数据，按出现频次排序
  const categoryList = useMemo(() => {
    const counted = countBy((g) => g.categories);
    const ordered = allCategories.filter((c) => counted.some(([k]) => k === c));
    const extra = counted.filter(([k]) => !ordered.includes(k)).map(([k]) => k);
    return [...ordered, ...extra];
  }, []);
  const mechanicList = useMemo(() => countBy((g) => g.mechanics).slice(0, 40), []);
  const yearList = useMemo(
    () => [...new Set(gameLibrary.map((g) => g.year_published ?? 0))].sort((a, b) => b - a),
    [],
  );

  const resetTo = (fn: () => void) => {
    fn();
    setPage(1);
  };

  /** 单个维度的选项切换（多选） */
  const toggle = <T,>(list: T[], v: T, set: (next: T[]) => void) => {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
    setPage(1);
  };

  const clearAll = () =>
    resetTo(() => {
      setKeyword('');
      setCategories([]);
      setPlayers([]);
      setYears([]);
      setDurations([]);
      setAges([]);
      setMechanics([]);
      setSort('hot');
    });

  /** 已选条件：集石样式胶囊，逐个可移除 */
  const chips = useMemo(() => {
    const out: { key: string; label: string; onRemove: () => void }[] = [];
    if (keyword.trim())
      out.push({
        key: 'kw',
        label: `关键词：${keyword.trim()}`,
        onRemove: () => resetTo(() => setKeyword('')),
      });
    categories.forEach((c) =>
      out.push({
        key: `cat-${c}`,
        label: `游戏分类：${c}`,
        onRemove: () => resetTo(() => setCategories((prev) => prev.filter((x) => x !== c))),
      }),
    );
    players.forEach((n) =>
      out.push({
        key: `p-${n}`,
        label: `玩家人数：${n === 14 ? '14+' : n}`,
        onRemove: () => resetTo(() => setPlayers((prev) => prev.filter((x) => x !== n))),
      }),
    );
    years.forEach((y) =>
      out.push({
        key: `y-${y}`,
        label: `出版年份：${y <= 0 ? '古代' : y}`,
        onRemove: () => resetTo(() => setYears((prev) => prev.filter((x) => x !== y))),
      }),
    );
    durations.forEach((d) =>
      out.push({
        key: `d-${d}`,
        label: `人均时长：${DURATION_OPTIONS[d].label}`,
        onRemove: () => resetTo(() => setDurations((prev) => prev.filter((x) => x !== d))),
      }),
    );
    ages.forEach((a) =>
      out.push({
        key: `a-${a}`,
        label: `适合年龄：${AGE_OPTIONS[a].label}`,
        onRemove: () => resetTo(() => setAges((prev) => prev.filter((x) => x !== a))),
      }),
    );
    mechanics.forEach((m) =>
      out.push({
        key: `m-${m}`,
        label: `机制：${m}`,
        onRemove: () => resetTo(() => setMechanics((prev) => prev.filter((x) => x !== m))),
      }),
    );
    return out;
  }, [keyword, categories, players, years, durations, ages, mechanics]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list = gameLibrary.filter((g) => {
      if (categories.length && !categories.some((c) => g.categories.includes(c))) return false;
      if (players.length) {
        const hit = players.some((n) => {
          const target = n === 14 ? 99 : n;
          const lower = n === 14 ? 14 : n;
          if (g.min_players == null || g.max_players == null) return false;
          return g.min_players <= target && g.max_players >= lower;
        });
        if (!hit) return false;
      }
      if (years.length && !(g.year_published != null && years.includes(g.year_published))) return false;
      if (durations.length) {
        const hit = durations.some((d) => {
          const { min, max } = DURATION_OPTIONS[d];
          if (g.play_time_minutes == null) return false;
          return g.play_time_minutes >= min && g.play_time_minutes <= max;
        });
        if (!hit) return false;
      }
      if (ages.length) {
        const age = g.min_age;
        if (age == null || !ages.some((a) => AGE_OPTIONS[a].test(age))) return false;
      }
      if (mechanics.length && !mechanics.some((m) => g.mechanics.includes(m))) return false;
      if (kw) {
        const hay = `${g.name} ${g.name_en} ${g.designers.join(' ')} ${g.categories.join(' ')}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (sort === 'newest') list = [...list].sort((a, b) => (b.year_published ?? 0) - (a.year_published ?? 0));
    if (sort === 'oldest') list = [...list].sort((a, b) => (a.year_published ?? 0) - (b.year_published ?? 0));
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return list;
  }, [keyword, categories, players, years, durations, ages, mechanics, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const goPage = (p: number) => {
    setPage(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** 集石样式：一行一个维度，标题左对齐固定宽度，右侧选项胶囊 */
  const Row = ({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '9px 0',
        borderTop: '1px solid var(--tm-border)',
      }}
    >
      <div
        style={{
          width: isMobile ? 'auto' : 74,
          flexShrink: 0,
          fontSize: 12.5,
          color: 'var(--tm-text-secondary)',
          lineHeight: '26px',
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1, minWidth: 0, alignItems: 'center' }}>
        {children}
        {extra}
      </div>
    </div>
  );

  /** 方形/圆角选项胶囊 */
  const Cap = ({
    label,
    active,
    onClick,
    count,
  }: {
    label: string;
    active?: boolean;
    onClick: () => void;
    count?: number;
  }) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="tm-press"
      style={{
        border: 'none',
        background: active ? 'var(--tm-action)' : '#f4f5f7',
        color: active ? '#fff' : 'var(--tm-text-secondary)',
        fontSize: 12.5,
        lineHeight: '24px',
        padding: '0 10px',
        minWidth: label.length <= 2 ? 30 : undefined,
        borderRadius: label.length <= 2 && /^\d+$/.test(label) ? 6 : 999,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: active ? 600 : 400,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{ fontSize: 11, opacity: 0.6, marginLeft: count ? 4 : 0 }}>{count}</span>
      )}
    </button>
  );

  const visibleCats = allCats ? categoryList : categoryList.slice(0, 24);

  return (
    <div style={pageContainerStyle} className="tm-page-enter">
      {/* 页头 */}
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: isMobile ? 22 : 28, fontWeight: 800, letterSpacing: '-.3px' }}>
          桌游库
        </h1>
      </div>

      {/* ── 已选条件（集石样式） ── */}
      {chips.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            marginBottom: 10,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12.5,
              color: 'var(--tm-text-secondary)',
            }}
          >
            <SlidersOutlined /> 筛选条件
          </span>
          <span aria-hidden style={{ color: 'var(--tm-text-tertiary)' }}>
            &gt;
          </span>
          {chips.map((c) => (
            <span key={c.key} style={activeChip}>
              {c.label}
              <button
                type="button"
                aria-label={`移除条件 ${c.label}`}
                onClick={c.onRemove}
                style={chipClose}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAll} style={clearLink}>
            清空全部
          </button>
        </div>
      )}

      {/* ── 筛选面板 ── */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--tm-border)',
          borderRadius: 14,
          padding: isMobile ? '4px 14px 8px' : '4px 18px 8px',
          marginBottom: 14,
          boxShadow: '0 2px 8px rgba(17,24,39,.04)',
        }}
      >
        {panelOpen ? (
          <>
            <div style={{ borderTop: 'none' }}>
              <Row title="玩家人数">
                {PLAYER_COUNTS.map((n) => (
                  <Cap
                    key={n}
                    label={n === 14 ? '14+' : String(n)}
                    active={players.includes(n)}
                    onClick={() => toggle(players, n, setPlayers)}
                  />
                ))}
              </Row>
            </div>

            <Row
              title="游戏分类"
              extra={
                categoryList.length > 24 ? (
                  <button type="button" onClick={() => setAllCats((v) => !v)} style={moreLink}>
                    {allCats ? '收起' : `全部 ${categoryList.length} 个`}
                  </button>
                ) : undefined
              }
            >
              {visibleCats.map((c) => (
                <Cap
                  key={c}
                  label={c}
                  active={categories.includes(c)}
                  onClick={() => toggle(categories, c, setCategories)}
                />
              ))}
            </Row>

            <Row title="出版年份">
              {yearList.map((y) => (
                <Cap
                  key={y}
                  label={y <= 0 ? '古代' : String(y)}
                  active={years.includes(y)}
                  onClick={() => toggle(years, y, setYears)}
                />
              ))}
            </Row>

            <Row title="人均时长">
              {DURATION_OPTIONS.map((o, i) => (
                <Cap
                  key={o.label}
                  label={o.label}
                  active={durations.includes(i)}
                  onClick={() => toggle(durations, i, setDurations)}
                />
              ))}
            </Row>

            <Row title="适合年龄">
              {AGE_OPTIONS.map((o, i) => (
                <Cap
                  key={o.label}
                  label={o.label}
                  active={ages.includes(i)}
                  onClick={() => toggle(ages, i, setAges)}
                />
              ))}
            </Row>

            <Row title="更多条件">
              <Dropdown
                trigger={['click']}
                menu={{
                  items: mechanicList.map(([m, n]) => ({ key: m, label: `${m}（${n}）` })),
                  selectedKeys: mechanics,
                  onClick: ({ key }) => toggle(mechanics, String(key), setMechanics),
                  style: { maxHeight: 320, overflowY: 'auto' },
                }}
              >
                <button type="button" style={dropdownBtn}>
                  机制
                  {mechanics.length ? `：已选 ${mechanics.length} 项` : ''}
                  <DownOutlined style={{ fontSize: 10, marginLeft: 4 }} />
                </button>
              </Dropdown>
            </Row>
          </>
        ) : null}

        <div style={{ textAlign: 'center', paddingTop: 4 }}>
          <button type="button" onClick={() => setPanelOpen((v) => !v)} style={quickLink}>
            {panelOpen ? <UpOutlined /> : <DownOutlined />} 快速筛选
          </button>
        </div>
      </div>

      {/* 结果工具条 */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Segmented<SortKey>
            value={sort}
            onChange={(v) => resetTo(() => setSort(v))}
            options={SORT_OPTIONS}
          />
          <Segmented<ViewMode>
            value={view}
            onChange={setView}
            options={[
              { label: <AppstoreOutlined />, value: 'grid' },
              { label: <SwapOutlined />, value: 'list' },
            ]}
          />
        </div>
        <span style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}>
          第 {filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–
          {Math.min(safePage * PAGE_SIZE, filtered.length)} 条 / 共 {filtered.length} 条
        </span>
      </div>

      {/* 列表 */}
      {pageItems.length === 0 ? (
        <div
          style={{
            background: '#fff',
            border: '1px solid var(--tm-border)',
            borderRadius: 16,
            padding: '48px 20px',
          }}
        >
          <Empty description="没有符合条件的桌游" style={{ padding: '0 0 8px' }}>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button className="tm-press" onClick={clearAll} style={ghostBtn}>
                清空筛选条件
              </Button>
              <Button className="tm-press" onClick={() => navigate('/rankings')} style={solidBtn}>
                看看 BGG 榜单
              </Button>
            </div>
          </Empty>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                view === 'grid'
                  ? isMobile
                    ? 'repeat(2, minmax(0, 1fr))'
                    : 'repeat(auto-fill, minmax(188px, 1fr))'
                  : '1fr',
              gap: isMobile ? 12 : 16,
            }}
          >
            {pageItems.map((g) =>
              view === 'grid' ? (
                <GameCard key={g.id} game={g} />
              ) : (
                <GameListRow key={g.id} game={g} onOpen={() => navigate(`/games/${g.slug}`)} />
              ),
            )}
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div
              style={{
                marginTop: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <PageBtn disabled={safePage <= 1} onClick={() => goPage(safePage - 1)}>
                <LeftArrow />
              </PageBtn>
              {pagerList(safePage, totalPages).map((p, idx) =>
                p === '…' ? (
                  <span key={`gap-${idx}`} style={{ color: 'var(--tm-text-tertiary)', paddingInline: 2 }}>
                    …
                  </span>
                ) : (
                  <PageBtn key={p} active={p === safePage} onClick={() => goPage(p as number)}>
                    {p}
                  </PageBtn>
                ),
              )}
              <PageBtn disabled={safePage >= totalPages} onClick={() => goPage(safePage + 1)}>
                <RightArrow />
              </PageBtn>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── 局部组件 ── */

function PageBtn({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="tm-press"
      style={{
        minWidth: 34,
        height: 34,
        paddingInline: 10,
        borderRadius: 10,
        border: active ? '1px solid var(--tm-action)' : '1px solid var(--tm-border)',
        background: active ? 'var(--tm-action)' : '#fff',
        color: active ? '#fff' : 'var(--tm-text-secondary)',
        fontSize: 13,
        fontWeight: active ? 700 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function LeftArrow() {
  return (
    <span aria-hidden style={{ display: 'inline-block', transform: 'rotate(180deg)', lineHeight: 0 }}>
      <RightArrow />
    </span>
  );
}

function RightArrow() {
  return (
    <span aria-hidden style={{ lineHeight: 0 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block' }}>
        <path d="M9.3 5.7 8 7.1 13.9 12 8 16.9l1.3 1.4L16 12z" />
      </svg>
    </span>
  );
}

/** 列表视图的一行（比大卡更省竖向空间） */
function GameListRow({ game, onOpen }: { game: GameDetail; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tm-card tm-press"
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        textAlign: 'left',
        background: '#fff',
        border: '1px solid var(--tm-border)',
        borderRadius: 14,
        padding: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <img
        src={game.cover_image ?? ''}
        alt={game.name}
        loading="lazy"
        style={{
          width: 62,
          height: 78,
          objectFit: 'cover',
          borderRadius: 10,
          flexShrink: 0,
          background: 'var(--tm-surface-page)',
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--tm-text-primary)' }}>{game.name}</div>
        <div className="tm-clamp-1" style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 3 }}>
          {formatPlayers(game)} · {formatPlayTime(game)} · {formatAge(game)} ·{' '}
          {game.year_published ?? '年份暂无'}
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {game.categories.slice(0, 3).map((c) => (
            <span key={c} style={miniChip}>
              {c}
            </span>
          ))}
        </div>
      </div>
      <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
        <PictureOutlined /> {game.player_images.length + game.official_images.length}
      </span>
    </button>
  );
}

/* ── 工具 ── */

function pagerList(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push('…');
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}

/* ── 样式片段 ── */

const activeChip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--tm-action)',
  color: '#fff',
  fontSize: 12.5,
  lineHeight: '24px',
  padding: '0 6px 0 10px',
  borderRadius: 6,
  fontWeight: 600,
};

const chipClose: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#fff',
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 2px',
  fontFamily: 'inherit',
  opacity: 0.9,
};

const clearLink: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--tm-text-tertiary)',
  fontSize: 12.5,
  cursor: 'pointer',
  fontFamily: 'inherit',
  textDecoration: 'underline',
};

const moreLink: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--tm-link)',
  fontSize: 12.5,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
};

const dropdownBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  border: '1px solid var(--tm-border-strong)',
  background: '#fff',
  borderRadius: 6,
  height: 26,
  paddingInline: 10,
  fontSize: 12.5,
  color: 'var(--tm-text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const quickLink: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--tm-link)',
  fontSize: 12.5,
  cursor: 'pointer',
  fontFamily: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
};

const ghostBtn: React.CSSProperties = {
  border: '1px solid var(--tm-border-strong)',
  background: '#fff',
  color: 'var(--tm-text-primary)',
  borderRadius: 999,
  padding: '4px 20px',
  height: 34,
  fontSize: 14,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const solidBtn: React.CSSProperties = {
  border: 'none',
  background: 'var(--tm-action)',
  color: '#fff',
  borderRadius: 999,
  padding: '4px 20px',
  height: 34,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const miniChip: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '18px',
  padding: '0 7px',
  borderRadius: 6,
  background: 'var(--tm-tint)',
  color: 'var(--tm-link)',
};
