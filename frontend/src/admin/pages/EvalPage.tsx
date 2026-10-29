/**
 * P3 评测中心：四维评测（Context Recall / Precision、Faithfulness、Answer Relevance）。
 *
 * 页面职责：
 * - 用例管理：维护「问题 + 参考答案」题库，跑分才有稳定口径；
 * - 发起评测：后台批量跑「检索 → 生成 → 裁判」，前端轮询进度；
 * - 结果查看：四指标均值、通过率、逐条 badcase（答案 / 裁判理由 / 命中的资料）。
 * 所有数字都来自接口真实结果，未评估的指标显示「—」，绝不补 0。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  BarChartOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import { ErrorAlert, TableSkeleton } from '../components/AdminStates';
import {
  createEvalCase,
  createEvalRun,
  deleteEvalCase,
  deleteEvalRun,
  fetchAdminGames,
  fetchEvalCases,
  fetchEvalRunDetail,
  fetchEvalRuns,
  updateEvalCase,
} from '../adminApi';
import type {
  AdminGame,
  EvalCase,
  EvalCasePayload,
  EvalResultItem,
  EvalRun,
  EvalRunDetail,
} from '../adminTypes';

const { Text, Paragraph } = Typography;

const METRIC_META: Array<{
  key: 'context_recall' | 'context_precision' | 'faithfulness' | 'answer_relevance';
  label: string;
  hint: string;
}> = [
  {
    key: 'context_recall',
    label: '上下文召回',
    hint: '参考答案里的关键信息，有多少能在检索资料中找到',
  },
  {
    key: 'context_precision',
    label: '上下文精确',
    hint: '检索资料里相关内容占比，以及相关片段是否靠前',
  },
  {
    key: 'faithfulness',
    label: '忠实度',
    hint: '答案中的事实是否都能在资料中找到依据（衡量幻觉）',
  },
  {
    key: 'answer_relevance',
    label: '答案相关性',
    hint: '答案是否直接、完整地回应问题',
  },
];

const LEVEL_LABEL: Record<number, string> = {
  1: 'L1 结构化',
  2: 'L2 规则书',
  3: 'L3 BGG',
  4: 'L4 无依据',
};

const STATUS_META: Record<EvalRun['status'], { text: string; color: string }> = {
  pending: { text: '排队中', color: 'default' },
  running: { text: '评测中', color: 'processing' },
  completed: { text: '已完成', color: 'success' },
  failed: { text: '失败', color: 'error' },
};

function percent(v: number | null | undefined): string {
  return typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : '—';
}

function scoreColor(v: number | null): string {
  if (v === null) return 'var(--tm-text-tertiary, #999)';
  if (v >= 0.8) return '#389e0d';
  if (v >= 0.6) return '#d48806';
  return '#cf1322';
}

function fmtTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN');
}

/** 单条结果的展开区：答案、裁判理由、命中的资料、错误 */
function ResultDetail({ item }: { item: EvalResultItem }) {
  const reasons = item.judge_reasons?.reasons ?? {};
  const judgeError = item.judge_reasons?.error;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {item.error && (
        <Alert type="error" showIcon message={item.error} style={{ marginBottom: 0 }} />
      )}
      <div>
        <Text strong>系统回答</Text>
        <Paragraph
          style={{
            margin: '6px 0 0',
            whiteSpace: 'pre-wrap',
            background: 'var(--tm-surface-sunken, #fafafa)',
            border: '1px solid var(--tm-border)',
            borderRadius: 8,
            padding: 12,
          }}
        >
          {item.answer || '（空回答）'}
        </Paragraph>
      </div>
      <Descriptions size="small" column={1} bordered>
        {METRIC_META.map((m) => (
          <Descriptions.Item
            key={m.key}
            label={
              <Tooltip title={m.hint}>
                <span>{m.label}</span>
              </Tooltip>
            }
          >
            <Text style={{ color: scoreColor(item[m.key]) }}>
              {percent(item[m.key])}
            </Text>
            {reasons[m.key] && (
              <Text type="secondary" style={{ marginLeft: 10 }}>
                {reasons[m.key]}
              </Text>
            )}
          </Descriptions.Item>
        ))}
        {item.reference_answer && (
          <Descriptions.Item label="参考答案">
            <Text type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
              {item.reference_answer}
            </Text>
          </Descriptions.Item>
        )}
      </Descriptions>
      {judgeError && <Alert type="warning" showIcon message={judgeError} />}
      <div>
        <Text strong>命中的资料（{item.contexts?.length ?? 0} 段）</Text>
        <Collapse
          size="small"
          style={{ marginTop: 8 }}
          items={(item.contexts ?? []).map((ctx, i) => ({
            key: String(i),
            label: `片段 ${i + 1}`,
            children: (
              <Text style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ctx}</Text>
            ),
          }))}
        />
        {(!item.contexts || item.contexts.length === 0) && (
          <Text type="secondary">本次未检索到资料</Text>
        )}
      </div>
    </div>
  );
}

function RunSummary({ run }: { run: EvalRunDetail }) {
  const s = run.summary;
  const levelText = Object.entries(s?.levels ?? {})
    .map(([lv, n]) => `${LEVEL_LABEL[Number(lv)] ?? `L${lv}`} × ${n}`)
    .join('，');
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        {METRIC_META.map((m) => (
          <Card size="small" key={m.key}>
            <Statistic
              title={
                <Tooltip title={m.hint}>
                  <span>{m.label}</span>
                </Tooltip>
              }
              value={
                typeof s?.avg?.[m.key] === 'number'
                  ? Math.round((s.avg[m.key] as number) * 1000) / 10
                  : undefined
              }
              suffix={typeof s?.avg?.[m.key] === 'number' ? '%' : ''}
              valueStyle={{ color: scoreColor(s?.avg?.[m.key] ?? null) }}
            />
          </Card>
        ))}
        <Card size="small">
          <Statistic
            title="通过率"
            value={
              typeof s?.pass_rate === 'number'
                ? Math.round(s.pass_rate * 1000) / 10
                : undefined
            }
            suffix={typeof s?.pass_rate === 'number' ? '%' : ''}
            valueStyle={{ color: scoreColor(s?.pass_rate ?? null) }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            阈值 {percent(s?.pass_threshold ?? 0.6)}
          </Text>
        </Card>
        <Card size="small">
          <Statistic title="用例数" value={run.case_count} suffix="条" />
          {s && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              失败 {s.failed} 条
            </Text>
          )}
        </Card>
      </div>
      <Space size={8} wrap>
        <Tag color={STATUS_META[run.status].color}>{STATUS_META[run.status].text}</Tag>
        {run.note && <Tag>{run.note}</Tag>}
        {levelText && <Text type="secondary">检索层级：{levelText}</Text>}
        <Text type="secondary">
          开始 {fmtTime(run.started_at)} · 结束 {fmtTime(run.finished_at)}
        </Text>
      </Space>
      {run.status === 'running' && (
        <Progress
          percent={
            run.case_count
              ? Math.round((run.completed_count / run.case_count) * 100)
              : 0
          }
          status="active"
        />
      )}
      {run.error && <Alert type="error" showIcon message={run.error} />}
    </div>
  );
}

export default function EvalPage() {
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [casesLoading, setCasesLoading] = useState(true);
  const [casesError, setCasesError] = useState<string | null>(null);

  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [detail, setDetail] = useState<EvalRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [gameFilter, setGameFilter] = useState<number | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [onlyLow, setOnlyLow] = useState(false);

  const [games, setGames] = useState<AdminGame[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EvalCase | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const timerRef = useRef<number | null>(null);

  const loadCases = useCallback(async () => {
    setCasesLoading(true);
    setCasesError(null);
    try {
      setCases(await fetchEvalCases());
    } catch (e) {
      setCasesError((e as Error).message);
    } finally {
      setCasesLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (selectId?: number) => {
    setRunsError(null);
    try {
      const rows = await fetchEvalRuns(30);
      setRuns(rows);
      setSelectedRunId((prev) => selectId ?? prev ?? rows[0]?.id ?? null);
    } catch (e) {
      setRunsError((e as Error).message);
    }
  }, []);

  const loadDetail = useCallback(async (runId: number) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await fetchEvalRunDetail(runId));
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCases();
    void loadRuns();
  }, [loadCases, loadRuns]);

  useEffect(() => {
    if (selectedRunId === null) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedRunId);
  }, [selectedRunId, loadDetail]);

  // 评测在后台跑：pending/running 时每 4 秒拉一次详情，完成后刷新批次列表
  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!detail || !['pending', 'running'].includes(detail.status)) return;
    timerRef.current = window.setInterval(async () => {
      try {
        const next = await fetchEvalRunDetail(detail.id);
        setDetail(next);
        if (next.status === 'completed' || next.status === 'failed') {
          await loadRuns(next.id);
        }
      } catch {
        // 轮询失败静默：下一轮继续，不打断页面
      }
    }, 4000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [detail, loadRuns]);

  const gameOptions = useMemo(() => {
    const map = new Map<number, string>();
    cases.forEach((c) => {
      if (c.game_id) map.set(c.game_id, c.game_name || `#${c.game_id}`);
    });
    games.forEach((g) => {
      if (!map.has(g.id)) map.set(g.id, g.name);
    });
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [cases, games]);

  const openCreate = async () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, game_id: gameFilter });
    setModalOpen(true);
    if (games.length === 0) {
      try {
        // 后端 page_size 上限为 100；当前桌游库 47 款，一次即可取全
        const res = await fetchAdminGames({ page: 1, page_size: 100 });
        setGames(res.items);
      } catch {
        // 拉不到桌游列表时仍可手填 game_id 之外的字段；用例可不绑定游戏
      }
    }
  };

  const openEdit = (row: EvalCase) => {
    setEditing(row);
    form.setFieldsValue({
      game_id: row.game_id ?? undefined,
      question: row.question,
      reference_answer: row.reference_answer ?? '',
      reference_chunks: (row.reference_chunks ?? []).join(','),
      tags: row.tags ?? '',
      enabled: row.enabled,
    });
    setModalOpen(true);
  };

  const submitCase = async () => {
    const values = await form.validateFields();
    const rawChunks = String(values.reference_chunks ?? '').trim();
    const chunks = rawChunks
      ? rawChunks
          .split(/[,，\s]+/)
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 0)
      : null;
    const payload: EvalCasePayload = {
      game_id: values.game_id ?? null,
      question: values.question.trim(),
      reference_answer: values.reference_answer?.trim() || null,
      reference_chunks: chunks,
      tags: values.tags?.trim() || null,
      enabled: Boolean(values.enabled),
    };
    setSaving(true);
    try {
      if (editing) await updateEvalCase(editing.id, payload);
      else await createEvalCase(payload);
      message.success(editing ? '用例已保存' : '用例已新增');
      setModalOpen(false);
      await loadCases();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleCase = async (row: EvalCase, enabled: boolean) => {
    try {
      await updateEvalCase(row.id, { enabled });
      setCases((prev) => prev.map((c) => (c.id === row.id ? { ...c, enabled } : c)));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const removeCase = async (row: EvalCase) => {
    try {
      await deleteEvalCase(row.id);
      message.success('已删除');
      await loadCases();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const startRun = async () => {
    setStarting(true);
    try {
      const run = await createEvalRun({
        game_id: gameFilter,
        note: gameFilter ? undefined : '全部启用用例',
      });
      message.success(`评测已启动（批次 #${run.id}），完成后自动刷新`);
      await loadRuns(run.id);
      setSelectedRunId(run.id);
      await loadDetail(run.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const removeRun = async (runId: number) => {
    try {
      await deleteEvalRun(runId);
      message.success('批次已删除');
      setSelectedRunId(null);
      setDetail(null);
      await loadRuns();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const results = useMemo(() => {
    const rows = detail?.results ?? [];
    if (!onlyLow) return rows;
    const threshold = detail?.summary?.pass_threshold ?? 0.6;
    return rows.filter((r) => r.error || r.overall === null || r.overall < threshold);
  }, [detail, onlyLow]);

  const resultColumns: ColumnsType<EvalResultItem> = [
    {
      title: '问题',
      dataIndex: 'question',
      width: 260,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text ellipsis style={{ maxWidth: 250 }}>
            {v}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '层级',
      dataIndex: 'level',
      width: 100,
      render: (lv: number | null) =>
        lv ? <Tag>{LEVEL_LABEL[lv] ?? `L${lv}`}</Tag> : '—',
    },
    {
      title: '总分',
      dataIndex: 'overall',
      width: 110,
      sorter: (a, b) => (a.overall ?? -1) - (b.overall ?? -1),
      render: (v: number | null) => (
        <Tag color={v === null ? 'default' : v >= 0.6 ? 'success' : 'error'}>
          {percent(v)}
        </Tag>
      ),
    },
    ...METRIC_META.map((m) => ({
      title: m.label,
      dataIndex: m.key,
      width: 110,
      render: (v: number | null) => (
        <span style={{ color: scoreColor(v) }}>{percent(v)}</span>
      ),
    })),
    {
      title: '耗时',
      dataIndex: 'latency_ms',
      width: 90,
      render: (v: number | null) => (v ? `${(v / 1000).toFixed(1)}s` : '—'),
    },
    {
      title: '状态',
      dataIndex: 'error',
      width: 90,
      render: (err: string | null) =>
        err ? (
          <Tooltip title={err}>
            <Tag color="error">异常</Tag>
          </Tooltip>
        ) : (
          <Tag color="success">正常</Tag>
        ),
    },
  ];

  const caseColumns: ColumnsType<EvalCase> = [
    {
      title: '问题',
      dataIndex: 'question',
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{v}</Text>
          {row.reference_answer && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              参考答案：{row.reference_answer.slice(0, 60)}
              {row.reference_answer.length > 60 ? '…' : ''}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '桌游',
      dataIndex: 'game_name',
      width: 160,
      render: (v: string | null, row) =>
        v || (row.game_id ? `#${row.game_id}` : '自动识别'),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 100,
      render: (v: string | null) => (v ? <Tag>{v}</Tag> : '—'),
    },
    {
      title: '参考切片',
      dataIndex: 'reference_chunks',
      width: 120,
      render: (v: number[] | null) =>
        v && v.length ? v.join(', ') : '—',
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean, row) => (
        <Switch size="small" checked={v} onChange={(checked) => void toggleCase(row, checked)} />
      ),
    },
    {
      title: '操作',
      width: 130,
      render: (_, row) => (
        <Space size={6}>
          <Button size="small" type="link" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm title="删除这条用例？" onConfirm={() => void removeCase(row)}>
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <AdminPageCard
        title="评测中心"
        icon={<ExperimentOutlined />}
        description="用 LLM-as-judge 按四个维度给 RAG 打分：上下文召回 / 上下文精确 / 忠实度 / 答案相关性。改动检索或模型前后跑同一题库，即可判断是否真的变好。"
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="全部桌游"
              style={{ width: 180 }}
              value={gameFilter}
              onChange={(v) => setGameFilter(v)}
              options={gameOptions}
            />
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={starting}
              disabled={cases.filter((c) => c.enabled).length === 0}
              onClick={() => void startRun()}
            >
              开始评测
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void loadCases();
                void loadRuns();
                if (selectedRunId) void loadDetail(selectedRunId);
              }}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Tabs
          items={[
            {
              key: 'results',
              label: (
                <span>
                  <BarChartOutlined /> 评测结果
                </span>
              ),
              children: (
                <div style={{ display: 'grid', gap: 16 }}>
                  <Space wrap>
                    <Select
                      style={{ minWidth: 280 }}
                      placeholder="选择评测批次"
                      value={selectedRunId ?? undefined}
                      onChange={(v) => setSelectedRunId(v)}
                      options={runs.map((r) => ({
                        value: r.id,
                        label: `#${r.id} · ${STATUS_META[r.status].text} · ${r.completed_count}/${r.case_count} · ${fmtTime(r.created_at)}`,
                      }))}
                    />
                    {detail && (
                      <Popconfirm
                        title="删除这个评测批次及其结果？"
                        onConfirm={() => void removeRun(detail.id)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>
                          删除批次
                        </Button>
                      </Popconfirm>
                    )}
                    <Space size={6}>
                      <Switch size="small" checked={onlyLow} onChange={setOnlyLow} />
                      <Text type="secondary">仅看未通过 / 异常</Text>
                    </Space>
                  </Space>

                  {runsError && <ErrorAlert error={runsError} onRetry={() => void loadRuns()} />}
                  {detailError && (
                    <ErrorAlert
                      error={detailError}
                      onRetry={() => selectedRunId && void loadDetail(selectedRunId)}
                    />
                  )}
                  {detailLoading && !detail && <TableSkeleton rows={6} />}

                  {detail ? (
                    <div style={{ display: 'grid', gap: 14 }}>
                      <RunSummary run={detail} />
                      <Table
                        rowKey="id"
                        size="small"
                        columns={resultColumns}
                        dataSource={results}
                        pagination={false}
                        scroll={{ x: 1200 }}
                        expandable={{
                          expandedRowRender: (item) => <ResultDetail item={item} />,
                        }}
                        locale={{
                          emptyText: (
                            <Empty
                              description={
                                detail.status === 'running'
                                  ? '评测进行中，结果会随完成条数陆续出现'
                                  : '暂无结果'
                              }
                            />
                          ),
                        }}
                      />
                    </div>
                  ) : (
                    !detailLoading && (
                      <Empty description="还没有评测批次，点击右上角「开始评测」" />
                    )
                  )}
                </div>
              ),
            },
            {
              key: 'cases',
              label: `用例管理（${cases.length}）`,
              children: (
                <div style={{ display: 'grid', gap: 14 }}>
                  <Space wrap>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => void openCreate()}>
                      新增用例
                    </Button>
                    <Text type="secondary">
                      启用 {cases.filter((c) => c.enabled).length} 条 · 参考答案用于 Context Recall，缺失时该指标不评分
                    </Text>
                  </Space>
                  {casesError && <ErrorAlert error={casesError} onRetry={() => void loadCases()} />}
                  {casesLoading ? (
                    <TableSkeleton rows={6} />
                  ) : (
                    <Table
                      rowKey="id"
                      size="small"
                      columns={caseColumns}
                      dataSource={cases}
                      pagination={{ pageSize: 10, hideOnSinglePage: true }}
                      scroll={{ x: 900 }}
                    />
                  )}
                </div>
              ),
            },
          ]}
        />
      </AdminPageCard>

      <Modal
        title={editing ? `编辑用例 #${editing.id}` : '新增评测用例'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submitCase()}
        confirmLoading={saving}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="game_id" label="桌游（可选）" extra="不选则由系统按问题自动识别">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择桌游"
              options={gameOptions}
            />
          </Form.Item>
          <Form.Item
            name="question"
            label="问题"
            rules={[{ required: true, message: '请输入评测问题' }]}
          >
            <Input.TextArea rows={2} maxLength={500} showCount placeholder="用户真实提问" />
          </Form.Item>
          <Form.Item
            name="reference_answer"
            label="参考答案"
            extra="按规则书原文整理；留空则该用例不计算 Context Recall"
          >
            <Input.TextArea rows={4} maxLength={4000} showCount />
          </Form.Item>
          <Form.Item
            name="reference_chunks"
            label="标准切片序号（可选）"
            extra="逗号分隔，如 36,37；便于人工复核命中位置"
          >
            <Input placeholder="36,37" />
          </Form.Item>
          <Form.Item name="tags" label="标签（可选）">
            <Input maxLength={120} placeholder="休息 / 战斗 / 成长" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
