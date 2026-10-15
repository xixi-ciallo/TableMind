import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import {
  BookOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  ReloadOutlined,
  RobotOutlined,
  StarOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import AdminPageCard from '../AdminPageCard';
import { CardGridSkeleton, ErrorResult } from '../components/AdminStates';
import { BarCompareChart, ChartCard, ChartLegend, DonutChart, HBarList, LineTrendChart } from '../components/AdminCharts';
import { fetchAdminStats, fetchRuleDocList } from '../adminApi';
import type { AdminStats, RuleDocSummary } from '../adminTypes';

const C = {
  brand: '#ff8f6d',
  action: '#d93d1a',
  info: '#0e7fb8',
  purple: '#8b5cf6',
  teal: '#14b8a6',
};

interface MetricCard {
  label: string;
  value: number | null;
  icon: React.ReactNode;
  hint: string;
  path?: string;
}

/** 指标卡：数值来自 GET /api/admin/stats，缺字段显示「暂无数据」而不是补 0 */
function MetricCard({ label, value, icon, hint, path }: MetricCard) {
  const navigate = useNavigate();
  const card = (
    <div
      className={path ? 'tm-card' : undefined}
      onClick={path ? () => navigate(path) : undefined}
      role={path ? 'button' : undefined}
      tabIndex={path ? 0 : undefined}
      onKeyDown={
        path
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(path);
              }
            }
          : undefined
      }
      style={{
        background: 'var(--tm-surface-card)',
        border: '1px solid var(--tm-border)',
        borderRadius: 'var(--tm-radius-lg)',
        padding: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        cursor: path ? 'pointer' : 'default',
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: 'var(--tm-radius-md)',
          background: 'linear-gradient(135deg, var(--tm-brand-light), var(--tm-action))',
          color: '#fff',
          fontSize: 19,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'var(--tm-shadow-action)',
        }}
      >
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 25,
            fontWeight: 700,
            lineHeight: 1.15,
            color: 'var(--tm-text-primary)',
          }}
        >
          {value == null ? (
            <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--tm-text-tertiary)' }}>
              暂无数据
            </span>
          ) : (
            value.toLocaleString('zh-CN')
          )}
        </div>
        <div style={{ fontSize: 13, color: 'var(--tm-text-secondary)', marginTop: 4 }}>{label}</div>
      </div>
    </div>
  );

  return path ? <Tooltip title={hint}>{card}</Tooltip> : card;
}

function fmtDate(d: string): string {
  // 后端返回 YYYY-MM-DD
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  return `${parts[1]}/${parts[2]}`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [range, setRange] = useState(14);

  /** 规则文档总览：说明书款数与切片总数，与统计接口并行拉取 */
  const [docs, setDocs] = useState<RuleDocSummary[] | null>(null);
  useEffect(() => {
    fetchRuleDocList()
      .then(setDocs)
      .catch(() => setDocs(null));
  }, [version]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    // range 决定日轴长度，必须传给后端，否则切换时间范围无效果
    fetchAdminStats(range)
      .then((data) => {
        if (alive) setStats(data);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setStats(null);
        setError(e instanceof Error ? e.message : '获取统计数据失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [version, range]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);

  const cards: MetricCard[] = [
    {
      label: '注册用户',
      value: stats?.user_count ?? null,
      icon: <TeamOutlined />,
      hint: '前往用户管理查看与启停账号',
      path: '/admin/users',
    },
    {
      label: '收录桌游',
      value: stats?.game_count ?? null,
      icon: <DatabaseOutlined />,
      hint: '前往桌游管理维护桌游资料',
      path: '/admin/games',
    },
    {
      label: '评测数',
      value: stats?.review_count ?? null,
      icon: <StarOutlined />,
      hint: '前往内容审核处理违规评测',
      path: '/admin/moderation',
    },
    {
      label: '帖子数',
      value: stats?.post_count ?? null,
      icon: <FileTextOutlined />,
      hint: '前往内容审核处理违规帖子',
      path: '/admin/moderation',
    },
    {
      label: 'AI 调用量',
      value: stats?.ai_call_count ?? null,
      icon: <RobotOutlined />,
      hint: 'AI 规则助手累计调用次数',
    },
    {
      label: '规则说明书',
      value: docs ? docs.length : null,
      icon: <BookOutlined />,
      hint: docs?.length
        ? `共 ${docs.reduce((s, d) => s + (d.chunk_count ?? 0), 0)} 条切片，前往规则文档管理`
        : '前往规则文档上传说明书',
      path: '/admin/rule-docs',
    },
  ];

  // ── 图表数据（全部来自后端真实聚合，缺失就是空） ──
  const series = stats?.series ?? [];
  const trendSeries = useMemo(
    () => [
      { key: 'users', label: '新增用户', color: C.action, values: series.map((s) => s.values.users ?? 0) },
      { key: 'reviews', label: '评测', color: C.info, values: series.map((s) => s.values.reviews ?? 0) },
      { key: 'posts', label: '帖子', color: C.purple, values: series.map((s) => s.values.posts ?? 0) },
      { key: 'ai_calls', label: 'AI 调用', color: C.teal, values: series.map((s) => s.values.ai_calls ?? 0) },
    ],
    [series],
  );
  const trendLabels = series.map((s) => fmtDate(s.date));
  const hasTrend = series.length >= 2 && trendSeries.some((s) => s.values.some((v) => v > 0));

  const barSeries = useMemo(
    () => [
      { key: 'users', label: '用户', color: C.action, values: series.map((s) => s.values.users ?? 0) },
      { key: 'reviews', label: '评测', color: C.info, values: series.map((s) => s.values.reviews ?? 0) },
      { key: 'posts', label: '帖子', color: C.purple, values: series.map((s) => s.values.posts ?? 0) },
      { key: 'ai', label: 'AI', color: C.teal, values: series.map((s) => s.values.ai_calls ?? 0) },
    ],
    [series],
  );
  const hasBar = series.length > 0 && barSeries.some((s) => s.values.some((v) => v > 0));

  const ratingDist = stats?.rating_distribution ?? [];
  const hasDist = ratingDist.length > 0 && ratingDist.some((r) => r.count > 0);
  const distTotal = ratingDist.reduce((s, r) => s + r.count, 0);

  const tagUsage = stats?.tag_usage ?? [];
  const hasTags = tagUsage.length > 0 && tagUsage.some((t) => t.usage_count > 0);

  const topGames = stats?.top_games ?? [];
  const hasTopGames = topGames.length > 0;

  // 贡献占比：有数据才画，没数据就空态
  const contribItems =
    [
      { key: 'users', label: '注册用户', value: stats?.user_count ?? 0, color: C.action },
      { key: 'games', label: '收录桌游', value: stats?.game_count ?? 0, color: C.info },
      { key: 'reviews', label: '评测', value: stats?.review_count ?? 0, color: C.purple },
      { key: 'posts', label: '帖子', value: stats?.post_count ?? 0, color: C.teal },
      { key: 'ai', label: 'AI 调用', value: stats?.ai_call_count ?? 0, color: C.brand },
    ].filter((i) => i.value > 0) ?? [];

  return (
    <AdminPageCard
      title="数据仪表盘"
      description="指标与图表数据均来自 GET /api/admin/stats 的实时数据库聚合；接口返回空序列时图表显示空态，不做任何估算填充。"
      icon={<DashboardOutlined />}
      extra={
        <>
          <Segmented
            value={range}
            onChange={(v) => setRange(Number(v))}
            options={[
              { label: '7 天', value: 7 },
              { label: '14 天', value: 14 },
              { label: '30 天', value: 30 },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={reload} loading={loading}>
            刷新
          </Button>
        </>
      }
    >
      {loading ? (
        <CardGridSkeleton count={5} />
      ) : error ? (
        <ErrorResult error={error} onRetry={reload} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 指标卡 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
              gap: 14,
            }}
          >
            {cards.map((c) => (
              <MetricCard key={c.label} {...c} />
            ))}
          </div>

          {/* 趋势 + 占比 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 300px',
              gap: 18,
            }}
          >
            <ChartCard
              title="近期趋势"
              extra={<ChartLegend series={trendSeries} />}
              empty={!hasTrend}
            >
              <LineTrendChart labels={trendLabels} series={trendSeries} />
            </ChartCard>

            <ChartCard title="数据构成" empty={contribItems.length === 0}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <DonutChart items={contribItems} centerLabel="总量" />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {contribItems.map((i) => (
                    <div
                      key={i.key}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 3,
                          background: i.color,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: 'var(--tm-text-secondary)', flex: 1, minWidth: 0 }}>{i.label}</span>
                      <span style={{ color: 'var(--tm-text-primary)', fontWeight: 600 }}>
                        {i.value.toLocaleString('zh-CN')}
                      </span>
                    </div>
                  ))}
                  {contribItems.length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
                      统计接口已连通，但各项计数均为 0
                    </span>
                  )}
                </div>
              </div>
            </ChartCard>
          </div>

          {/* 柱状对比 + 评分分布 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
            <ChartCard
              title="内容量对比（按天）"
              extra={<ChartLegend series={barSeries.slice(0, 2)} />}
              empty={!hasBar}
            >
              <BarCompareChart labels={trendLabels} series={barSeries} height={200} />
            </ChartCard>

            <ChartCard title="评分分布" empty={!hasDist}>
              <HBarList
                items={ratingDist.map((r) => ({
                  key: String(r.rating),
                  label: `${r.rating} 分`,
                  value: r.count,
                  color: r.rating >= 8 ? C.action : r.rating >= 6 ? C.brand : C.info,
                }))}
                max={Math.max(1, ...ratingDist.map((r) => r.count))}
                valueLabel={(v) => `${v} 条`}
              />
              {hasDist && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
                  共 {distTotal} 条玩家评分
                </div>
              )}
            </ChartCard>
          </div>

          {/* Top 桌游 + 标签使用量 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 18 }}>
            <ChartCard
              title="评分最高桌游"
              empty={!hasTopGames}
              extra={
                hasTopGames ? (
                  <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
                    仅统计本站玩家已评分的桌游
                  </span>
                ) : undefined
              }
            >
              <HBarList
                items={topGames.map((g) => ({
                  key: String(g.id),
                  label: g.name,
                  value: g.avg_rating,
                  color: C.brand,
                  hint: `${g.rating_count} 人评分`,
                }))}
                max={10}
                valueLabel={(v) => `${v.toFixed(2)} 分`}
              />
            </ChartCard>

            <ChartCard title="标签使用量 Top" empty={!hasTags}>
              <HBarList
                items={tagUsage.map((t) => ({
                  key: t.name,
                  label: t.name,
                  value: t.usage_count,
                  color: t.type === 'mechanic' ? C.info : C.action,
                }))}
                valueLabel={(v) => `${v} 款`}
              />
            </ChartCard>
          </div>

          <div
            style={{
              padding: '12px 16px',
              borderRadius: 'var(--tm-radius-md)',
              background: 'var(--tm-info-tint)',
              border: '1px solid var(--tm-border)',
              color: 'var(--tm-info)',
              fontSize: 13,
              lineHeight: 1.75,
            }}
          >
            <b>口径说明：</b>所有计数为数据库真实行数；趋势图以服务器本地日期为日轴，缺口自然补 0（表示该日确实没有新增记录）。
            「标签使用量」按桌游 JSONB 字段中真实引用次数统计。
          </div>
        </div>
      )}
    </AdminPageCard>
  );
}
