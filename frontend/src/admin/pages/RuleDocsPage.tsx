import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import {
  BookOutlined,
  DeleteOutlined,
  InboxOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import { TableSkeleton, ErrorAlert, TableEmpty } from '../components/AdminStates';
import {
  deleteRuleDocs,
  fetchAdminGames,
  fetchRuleDocChunks,
  fetchRuleDocList,
  fetchRuleDocStatus,
  uploadRuleDoc,
} from '../adminApi';
import type { AdminGame, RuleChunkItem, RuleDocStatus, RuleDocSummary } from '../adminTypes';

const MAX_SIZE_MB = 20;
const ACCEPT = '.pdf,.txt,.md,.markdown,.jpg,.jpeg,.png,.webp';

interface SelectOption {
  value: string;
  label: string;
}

/** 顶部概览卡：数字全部由总览接口结果聚合得出，不写死 */
function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string | number;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div
      style={{
        flex: '1 1 170px',
        minWidth: 150,
        background: 'var(--tm-surface-card)',
        border: '1px solid var(--tm-border)',
        borderRadius: 'var(--tm-radius-lg)',
        padding: '14px 16px',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: 'var(--tm-text-primary)',
          marginTop: 4,
          lineHeight: 1.15,
        }}
      >
        {loading ? '—' : value}
      </div>
      {hint ? (
        <div style={{ fontSize: 11.5, color: 'var(--tm-text-tertiary)', marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
}

/** 切片内容预览：让管理员看到说明书实际被切成了什么 */
function ChunkList({ loading, chunks }: { loading: boolean; chunks: RuleChunkItem[] | null }) {
  if (loading) {
    return (
      <div style={{ padding: 12, color: 'var(--tm-text-tertiary)', fontSize: 12.5 }}>
        <Spin size="small" /> 正在加载切片…
      </div>
    );
  }
  if (!chunks || chunks.length === 0) {
    return (
      <div style={{ padding: 12, color: 'var(--tm-text-tertiary)', fontSize: 12.5 }}>
        暂无切片内容
      </div>
    );
  }
  return (
    <div style={{ padding: '4px 0', maxWidth: 860 }}>
      {chunks.map((c) => (
        <div
          key={c.chunk_index}
          style={{
            border: '1px solid var(--tm-border)',
            borderRadius: 'var(--tm-radius-md)',
            padding: '10px 12px',
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <Tag>#{c.chunk_index + 1}</Tag>
            <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
              {c.char_count ?? 0} 字
            </span>
            {c.has_embedding ? (
              <Tag color="success">已向量化</Tag>
            ) : (
              <Tag color="warning">未向量化</Tag>
            )}
          </div>
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.7,
              color: 'var(--tm-text-secondary)',
              whiteSpace: 'pre-wrap',
              maxHeight: 132,
              overflow: 'auto',
            }}
          >
            {c.content}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RuleDocsPage() {
  /* ── 库内总览 ── */
  const [summary, setSummary] = useState<RuleDocSummary[] | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** 详情抽屉：点击总览表中的某一行时展开，独立查看该桌游的说明书切片 */
  const [detailGame, setDetailGame] = useState<RuleDocSummary | null>(null);

  /* ── 上传：选择桌游 ── */
  const [keyword, setKeyword] = useState('');
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedGame, setSelectedGame] = useState<AdminGame | null>(null);

  const [status, setStatus] = useState<RuleDocStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  /* ── 上传状态 ── */
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  /** replace=清空旧切片后写入；append=接在后面累积（多页规则书图片用它） */
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  /** 串行队列：多文件逐个上传，避免后端「先删后插」相互覆盖 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const firstFileRef = useRef(true);

  /* ── 切片预览（按桌游缓存） ── */
  const [chunksByGame, setChunksByGame] = useState<Record<number, RuleChunkItem[] | null>>({});
  const [chunkLoading, setChunkLoading] = useState<Record<number, boolean>>({});

  const searchSeq = useRef(0);

  /* ── 数据加载 ── */

  const loadOptions = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const res = await fetchAdminGames({ page: 1, page_size: 20, q: q || undefined });
      if (seq !== searchSeq.current) return;
      setOptions(
        res.items.map((g) => ({
          value: String(g.id),
          label: g.name_en ? `${g.name}（${g.name_en}）` : g.name,
        })),
      );
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setOptions([]);
      message.error(e instanceof Error ? e.message : '桌游搜索失败');
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      setSummary(await fetchRuleDocList());
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : '获取规则文档列表失败');
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadChunks = useCallback(async (gameId: number) => {
    setChunkLoading((prev) => ({ ...prev, [gameId]: true }));
    try {
      const rows = await fetchRuleDocChunks(gameId);
      setChunksByGame((prev) => ({ ...prev, [gameId]: rows }));
    } catch {
      setChunksByGame((prev) => ({ ...prev, [gameId]: [] }));
    } finally {
      setChunkLoading((prev) => ({ ...prev, [gameId]: false }));
    }
  }, []);

  const loadStatus = useCallback(
    async (game: AdminGame) => {
      setStatusLoading(true);
      try {
        setStatus(await fetchRuleDocStatus(game.id));
      } catch {
        setStatus(null);
      } finally {
        setStatusLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadOptions('');
    void loadSummary();
  }, [loadOptions, loadSummary]);

  /* ── 派生数据 ── */

  const stats = useMemo(() => {
    const list = summary ?? [];
    return {
      games: list.length,
      chunks: list.reduce((s, r) => s + (r.chunk_count ?? 0), 0),
      vectorized: list.filter((r) => r.vectorized === true).length,
      pending: list.filter((r) => r.vectorized === false).length,
    };
  }, [summary]);

  const filtered = useMemo(() => {
    const list = summary ?? [];
    const kw = filter.trim().toLowerCase();
    if (!kw) return list;
    return list.filter(
      (r) =>
        (r.game_name ?? '').toLowerCase().includes(kw) || String(r.game_id).includes(kw),
    );
  }, [summary, filter]);

  /* ── 交互 ── */

  /** 把某桌游设为当前操作对象，并拉取状态与切片 */
  const focusGame = (game: AdminGame) => {
    setSelectedId(game.id);
    setSelectedGame(game);
    setOptions((prev) =>
      prev.some((o) => o.value === String(game.id))
        ? prev
        : [...prev, { value: String(game.id), label: game.name }],
    );
    setStatus(null);
    void loadStatus(game);
    void loadChunks(game.id);
  };

  /** 从总览表选中某行 */
  const selectFromSummary = (row: RuleDocSummary) => {
    focusGame({ id: row.game_id, name: row.game_name ?? `ID ${row.game_id}` });
  };

  const handleSelect = (value: string) => {
    const label = options.find((o) => o.value === value)?.label ?? String(value);
    focusGame({ id: Number(value), name: label });
  };

  const removeDocs = async (gameId: number) => {
    try {
      await deleteRuleDocs(gameId);
      message.success('已删除该桌游的规则文档');
      if (selectedId === gameId) {
        setStatus(null);
        setChunksByGame((prev) => ({ ...prev, [gameId]: null }));
      }
      await loadSummary();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const beforeUpload = (file: File) => {
    if (!(file instanceof File)) return Upload.LIST_IGNORE;
    if (file.size / 1024 / 1024 > MAX_SIZE_MB) {
      message.error(`${file.name} 超过 ${MAX_SIZE_MB}MB`);
      return Upload.LIST_IGNORE;
    }
    return true;
  };

  const customRequest: UploadProps['customRequest'] = (opt) => {
    const { file, onSuccess, onError } = opt;
    if (selectedId == null) {
      message.error('请先选择要关联的桌游');
      onError?.(new Error('未选择桌游'));
      return;
    }
    if (!(file instanceof File)) {
      onError?.(new Error('文件无效'));
      return;
    }
    // 一次拖入多个文件时，只有第一个按所选模式写入，其余一律追加，避免相互覆盖
    const thisMode = firstFileRef.current ? mode : 'append';
    firstFileRef.current = false;

    pendingRef.current += 1;
    setUploading(true);

    queueRef.current = queueRef.current.then(async () => {
      setProgress(0);
      try {
        const res = await uploadRuleDoc(selectedId, file, {
          mode: thisMode,
          onProgress: setProgress,
        });
        onSuccess?.(res);
        message.success(
          res.source === 'image-ocr'
            ? `${file.name} 已识别并入库（新增 ${res.added ?? 0} 片）`
            : `${file.name} 已上传（新增 ${res.added ?? 0} 片）`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : '上传失败';
        message.error(`${file.name}：${msg}`);
        onError?.(new Error(msg));
      } finally {
        pendingRef.current -= 1;
        setProgress(0);
        if (pendingRef.current === 0) {
          setUploading(false);
          if (selectedGame) void loadStatus(selectedGame);
          if (selectedId != null) void loadChunks(selectedId);
          void loadSummary();
        }
      }
    });
  };

  const reloadCurrent = () => {
    if (selectedGame) {
      void loadStatus(selectedGame);
      void loadChunks(selectedGame.id);
    }
  };

  /* ── 总览表 ── */

  const columns: TableColumnsType<RuleDocSummary> = [
    {
      title: 'ID',
      dataIndex: 'game_id',
      width: 64,
      render: (id: number) => <span style={{ color: 'var(--tm-text-secondary)' }}>{id}</span>,
    },
    {
      title: '桌游名称',
      dataIndex: 'game_name',
      ellipsis: true,
      render: (name: string | null) =>
        name ?? <span style={{ color: 'var(--tm-text-tertiary)' }}>暂无数据</span>,
    },
    {
      title: '切片',
      dataIndex: 'chunk_count',
      width: 84,
      sorter: (a, b) => (a.chunk_count ?? 0) - (b.chunk_count ?? 0),
      render: (v: number | null) =>
        v == null ? (
          <span style={{ color: 'var(--tm-text-tertiary)' }}>暂无数据</span>
        ) : (
          v
        ),
    },
    {
      title: '向量化',
      dataIndex: 'vectorized',
      width: 100,
      filters: [
        { text: '已向量化', value: true },
        { text: '待向量化', value: false },
      ],
      onFilter: (val, r) => r.vectorized === val,
      render: (v: boolean | null) =>
        v == null ? (
          <span style={{ color: 'var(--tm-text-tertiary)' }}>暂无数据</span>
        ) : v ? (
          <Tag color="success">已向量化</Tag>
        ) : (
          <Tag color="warning">待向量化</Tag>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 132,
      render: (_, row) => (
        <Space size={2}>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              selectFromSummary(row);
            }}
          >
            选中
          </Button>
          <Popconfirm
            title="删除该桌游的全部规则文档？"
            description="删除后 AI 将不再能引用这本说明书"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void removeDocs(row.game_id)}
          >
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              style={{ paddingInline: 0 }}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <AdminPageCard
      title="规则文档"
      description="上传桌游说明书（PDF / 文本 / 规则书图片），后端自动切分并向量化，供 AI 助手在回答规则问题时引用。"
      icon={<BookOutlined />}
    >
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        {/* 概览统计 */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatCard label="已收录说明书的桌游" value={stats.games} hint="款" loading={summaryLoading} />
          <StatCard label="规则切片总数" value={stats.chunks} hint="条文本片段" loading={summaryLoading} />
          <StatCard label="已向量化" value={stats.vectorized} hint="款（可被语义检索）" loading={summaryLoading} />
          <StatCard label="待向量化" value={stats.pending} hint="款（缺 embedding）" loading={summaryLoading} />
        </div>

        {/* 上传面板 */}
        <div
          style={{
            border: '1px solid var(--tm-border)',
            borderRadius: 'var(--tm-radius-lg)',
            padding: 16,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 10 }}>
            上传说明书
          </div>

          <Select
            showSearch
            allowClear
            style={{ width: '100%', maxWidth: 460 }}
            placeholder="① 按名称搜索并选择要关联的桌游"
            filterOption={false}
            loading={searching}
            searchValue={keyword}
            onSearch={setKeyword}
            onChange={handleSelect}
            onClear={() => {
              setSelectedId(null);
              setSelectedGame(null);
              setStatus(null);
              setKeyword('');
              void loadOptions('');
            }}
            notFoundContent={searching ? '搜索中…' : '没有匹配的桌游'}
            options={options}
            value={selectedId != null ? String(selectedId) : undefined}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 12,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12.5, color: 'var(--tm-text-secondary)' }}>写入方式</span>
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => {
                setMode(String(v) as 'replace' | 'append');
                firstFileRef.current = true;
              }}
              options={[
                { label: '替换整本', value: 'replace' },
                { label: '追加页', value: 'append' },
              ]}
            />
            <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
              {mode === 'append'
                ? '接在现有切片之后累积，适合逐页上传规则书图片'
                : '先清空该桌游旧切片再写入，适合整本 PDF / 文本'}
            </span>
          </div>

          <div style={{ marginTop: 12 }}>
            <Upload.Dragger
              accept={ACCEPT}
              multiple
              maxCount={10}
              showUploadList
              beforeUpload={beforeUpload}
              customRequest={customRequest}
              disabled={selectedId == null || uploading}
              style={{ padding: '18px 12px' }}
            >
              <p className="ant-upload-drag-icon" style={{ marginBottom: 6 }}>
                <InboxOutlined />
              </p>
              <p className="ant-upload-text" style={{ fontSize: 14 }}>
                {selectedId == null ? '请先选择桌游，再上传说明书' : '② 点击或拖拽说明书文件到此处'}
              </p>
              <p className="ant-upload-hint" style={{ fontSize: 12 }}>
                支持 {ACCEPT}，单文件不超过 {MAX_SIZE_MB}MB，可一次选多个（逐个上传）。
                图片会由视觉模型识别成文字后再切片，选「追加页」即可把整本规则书逐页累积
              </p>
            </Upload.Dragger>
            {uploading ? (
              <Progress
                percent={progress}
                size="small"
                status="active"
                style={{ marginTop: 10, maxWidth: 420 }}
              />
            ) : null}
          </div>

          {/* 当前桌游处理状态 */}
          {selectedGame ? (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)' }}>
                  当前桌游：{selectedGame.name}
                </span>
                {statusLoading ? (
                  <Spin size="small" />
                ) : status ? (
                  <>
                    <Tag>切片 {status.chunk_count ?? 0}</Tag>
                    {status.vectorized ? (
                      <Tag color="success">已向量化</Tag>
                    ) : (
                      <Tag color="warning">待向量化</Tag>
                    )}
                  </>
                ) : (
                  <Tag color="default">暂无状态</Tag>
                )}
                <Button
                  type="link"
                  size="small"
                  icon={<ReloadOutlined />}
                  style={{ paddingInline: 0, marginLeft: 'auto' }}
                  onClick={reloadCurrent}
                >
                  刷新
                </Button>
              </div>
              <ChunkList
                loading={!!chunkLoading[selectedGame.id]}
                chunks={chunksByGame[selectedGame.id] ?? null}
              />
            </div>
          ) : null}
        </div>

        {/* 库内总览 */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 10,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)' }}>
              库内规则文档
            </span>
            <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
              共 {summary?.length ?? 0} 款，点击任意行查看切片详情
            </span>
            <Input
              allowClear
              size="small"
              prefix={<SearchOutlined />}
              placeholder="按名称或 ID 筛选"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 220, marginLeft: 'auto' }}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadSummary()}>
              刷新
            </Button>
          </div>

          {summaryError ? (
            <ErrorAlert error={summaryError} onRetry={() => void loadSummary()} />
          ) : summaryLoading && summary === null ? (
            <TableSkeleton rows={4} />
          ) : (summary ?? []).length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="库里还没有任何规则文档，上传后 AI 回答规则问题时会直接引用"
              style={{ padding: '28px 0' }}
            />
          ) : (
            <>
              <Table<RuleDocSummary>
                rowKey={(r) => r.game_id}
                size="middle"
                columns={columns}
                dataSource={filtered}
                pagination={filtered.length > 12 ? { pageSize: 12, showSizeChanger: false } : false}
                scroll={{ x: 620 }}
                locale={{ emptyText: <TableEmpty emptyText="暂无规则文档" keywordApplied={!!filter.trim()} /> }}
                onRow={(r) => ({
                  onClick: () => {
                    setDetailGame(r);
                    if (!chunksByGame[r.game_id]) void loadChunks(r.game_id);
                  },
                  style: { cursor: 'pointer' },
                })}
              />
              <Drawer
              title={
                detailGame
                  ? `规则说明书详情 · ${detailGame.game_name ?? '未知桌游'}`
                  : '规则说明书详情'
              }
              open={!!detailGame}
              onClose={() => setDetailGame(null)}
              width={680}
              extra={
                detailGame ? (
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => {
                      focusGame({
                        id: detailGame.game_id,
                        name: detailGame.game_name ?? `ID ${detailGame.game_id}`,
                      });
                      setDetailGame(null);
                    }}
                  >
                    去上传 / 编辑
                  </Button>
                ) : null
              }
            >
              {detailGame && (
                <div>
                  <Space size={8} style={{ marginBottom: 14 }}>
                    <Tag>切片 {detailGame.chunk_count ?? 0}</Tag>
                    {detailGame.vectorized ? (
                      <Tag color="success">已向量化</Tag>
                    ) : (
                      <Tag color="warning">待向量化</Tag>
                    )}
                  </Space>
                  <ChunkList
                    loading={!!chunkLoading[detailGame.game_id]}
                    chunks={chunksByGame[detailGame.game_id] ?? null}
                  />
                </div>
              )}
            </Drawer>
          </>
          )}
        </div>

        {!summaryLoading && summary && summary.length > 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ borderRadius: 'var(--tm-radius-md)' }}
            message="AI 助手在命中对应桌游时，会优先引用这里上传的说明书内容作答，并标注「依据规则说明书」。"
          />
        ) : null}
      </Space>
    </AdminPageCard>
  );
}
