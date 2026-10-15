import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import GameRuleBookPanel from '../components/GameRuleBookPanel';
import { ErrorAlert, TableEmpty, TableSkeleton } from '../components/AdminStates';
import {
  createGame,
  deleteGame,
  fetchAdminGames,
  fetchTags,
  updateGame,
} from '../adminApi';
import { pagedPagination, useAdminPagedList } from '../useAdminList';
import { coverGradient } from '../../shared/coverGradient';
import type {
  AdminGame,
  AdminGamePayload,
  AdminTag,
} from '../adminTypes';

type NumField = number | null | undefined;

interface GameFormValues {
  name: string;
  name_en?: string;
  description?: string;
  cover_image?: string;
  min_players?: NumField;
  max_players?: NumField;
  play_time_minutes?: NumField;
  min_age?: NumField;
  complexity?: NumField;
  categories?: string[];
  mechanics?: string[];
  designers?: string[];
  artists?: string[];
  publisher?: string;
  year_published?: NumField;
  bgg_id?: NumField;
  bgg_url?: string;
  min_playtime?: NumField;
  max_playtime?: NumField;
  admin_note?: string;
}

const SORT_OPTIONS: { label: string; value: string }[] = [
  { label: '按 ID', value: 'id' },
  { label: '按名称', value: 'name' },
  { label: '按评分', value: '-avg_rating' },
  { label: '按年份', value: '-year_published' },
];

/** 「暂无数据」统一占位：后端字段为 null 时不编造任何估算值 */
function Cell({ children }: { children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') {
    return <span style={{ color: 'var(--tm-text-tertiary)' }}>暂无数据</span>;
  }
  return <>{children}</>;
}

function TagList({ items, colorStyle }: { items?: string[] | null; colorStyle: 'warm' | 'info' }) {
  if (!items || items.length === 0) return <Cell>{null}</Cell>;
  const style =
    colorStyle === 'warm'
      ? { background: 'var(--tm-tint)', color: 'var(--tm-link)', border: 'none' }
      : { background: 'var(--tm-info-tint)', color: 'var(--tm-info)', border: 'none' };
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {items.slice(0, 2).map((item) => (
        <Tag key={item} style={{ ...style, marginInlineEnd: 0 }}>
          {item}
        </Tag>
      ))}
      {items.length > 2 && (
        <Tag style={{ background: 'transparent', border: 'none', color: 'var(--tm-text-tertiary)' }}>
          +{items.length - 2}
        </Tag>
      )}
    </div>
  );
}

export default function GameManagePage() {
  const [sort, setSort] = useState('id');

  const [tagOptions, setTagOptions] = useState<{ category: string[]; mechanic: string[] }>({
    category: [],
    mechanic: [],
  });

  const [form] = Form.useForm<GameFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminGame | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [coverPreview, setCoverPreview] = useState<string>('');

  const list = useAdminPagedList<AdminGame>(
    ({ page, pageSize, search }) =>
      fetchAdminGames({
        page,
        page_size: pageSize,
        q: search,
        sort,
      }),
    { pageSize: 10 },
  );

  /** 标签候选：用于编辑弹窗的分类 / 机制多选 */
  useEffect(() => {
    let alive = true;
    fetchTags()
      .then((tags: AdminTag[]) => {
        if (!alive) return;
        const groups: { category: string[]; mechanic: string[] } = { category: [], mechanic: [] };
        for (const tag of tags) {
          if (tag.type === 'mechanic') groups.mechanic.push(tag.name);
          else if (tag.type === 'category') groups.category.push(tag.name);
        }
        setTagOptions(groups);
      })
      .catch(() => {
        /* 候选标签可选，失败时保持空即可 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const categoryOptions = useMemo(
    () => tagOptions.category.map((name) => ({ label: name, value: name })),
    [tagOptions],
  );
  const mechanicOptions = useMemo(
    () => tagOptions.mechanic.map((name) => ({ label: name, value: name })),
    [tagOptions],
  );

  const [formKey, setFormKey] = useState('create');
  const [initialValues, setInitialValues] = useState<Partial<GameFormValues>>({});

  const openCreate = () => {
    setEditing(null);
    setFormKey(`create-${Date.now()}`);
    setInitialValues({ min_players: null, max_players: null });
    setCoverPreview('');
    setModalOpen(true);
  };

  const openEdit = (record: AdminGame) => {
    setEditing(record);
    setFormKey(`edit-${record.id}`);
    setInitialValues({
      name: record.name ?? '',
      name_en: record.name_en ?? undefined,
      description: record.description ?? undefined,
      cover_image: record.cover_image ?? undefined,
      min_players: record.min_players ?? null,
      max_players: record.max_players ?? null,
      play_time_minutes: record.play_time_minutes ?? null,
      min_age: record.min_age ?? null,
      complexity: record.complexity ?? null,
      categories: record.categories ?? [],
      mechanics: record.mechanics ?? [],
      designers: record.designers ?? [],
      artists: record.artists ?? [],
      publisher: record.publisher ?? undefined,
      year_published: record.year_published ?? null,
      bgg_id: record.bgg_id ?? null,
      bgg_url: record.bgg_url ?? undefined,
      min_playtime: record.min_playtime ?? null,
      max_playtime: record.max_playtime ?? null,
      admin_note: record.admin_note ?? undefined,
    });
    setCoverPreview(record.cover_image ?? '');
    setModalOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      const payload: AdminGamePayload = {
        name: values.name.trim(),
        name_en: values.name_en?.trim() || null,
        description: values.description?.trim() || null,
        description_en: editing?.description_en ?? null,
        cover_image: values.cover_image?.trim() || null,
        min_players: values.min_players ?? null,
        max_players: values.max_players ?? null,
        play_time_minutes: values.play_time_minutes ?? null,
        min_age: values.min_age ?? null,
        complexity: values.complexity ?? null,
        categories: values.categories ?? [],
        mechanics: values.mechanics ?? [],
        designers: values.designers ?? [],
        artists: values.artists ?? [],
        publisher: values.publisher?.trim() || null,
        year_published: values.year_published ?? null,
        bgg_id: values.bgg_id ?? null,
        bgg_url: values.bgg_url?.trim() || null,
        min_playtime: values.min_playtime ?? null,
        max_playtime: values.max_playtime ?? null,
        admin_note: values.admin_note?.trim() || null,
      };
      if (!payload.name) {
        message.error('桌游名称不能为空');
        return;
      }

      setSubmitting(true);
      try {
        if (editing) {
          await updateGame(editing.id, payload);
          message.success('已保存桌游资料');
        } else {
          await createGame(payload);
          message.success('已提交新建桌游');
        }
        setModalOpen(false);
        list.reload();
      } catch (e) {
        message.error(e instanceof Error ? e.message : '保存失败');
      } finally {
        setSubmitting(false);
      }
    } catch {
      // 校验未通过：由表单自身提示
    }
  };

  const confirmDelete = useCallback(
    (record: AdminGame) => {
      Modal.confirm({
        title: '确认删除该桌游？',
        content: (
          <span>
            即将删除「{record.name}」（ID {record.id}），该操作不可恢复，
            同时会一并清除该桌游下的评测与规则文档切片。
          </span>
        ),
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          setDeletingId(record.id);
          try {
            await deleteGame(record.id);
            message.success('桌游已删除');
            list.reload();
          } catch (e) {
            message.error(e instanceof Error ? e.message : '删除失败');
          } finally {
            setDeletingId(null);
          }
        },
      });
    },
    [list],
  );

  const columns: TableColumnsType<AdminGame> = [
    {
      title: '封面',
      dataIndex: 'cover_image',
      width: 60,
      render: (v: string | null | undefined, record) => (
        <div
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 'var(--tm-radius-sm)',
            background: 'var(--tm-border)',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,.95)',
            fontSize: 17,
            fontWeight: 700,
          }}
        >
          {v ? (
            <img
              src={v}
              alt=""
              loading="lazy"
              decoding="async"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                background: coverGradient(record.id),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {record.name.charAt(0)}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'ID',
      dataIndex: 'id',
      width: 56,
      render: (v: number) => <span style={{ color: 'var(--tm-text-secondary)' }}>{v}</span>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 200,
      render: (v: string, record) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, lineHeight: 1.4 }}>{v}</div>
          {record.name_en && (
            <div className="tm-clamp-1" style={{ fontSize: 12, color: 'var(--tm-text-secondary)' }}>
              {record.name_en}
            </div>
          )}
        </div>
      ),
    },
    {
      title: '规则书',
      dataIndex: 'rule_chunk_count',
      width: 88,
      render: (v?: number | null) =>
        v && v > 0 ? (
          <Tooltip title={`已入库 ${v} 条规则切片，AI 可检索`}>
            <Tag color="success">{v} 片</Tag>
          </Tooltip>
        ) : (
          <Tooltip title="尚无规则说明书，点「编辑」上传规则书图片或 PDF">
            <Tag color="default">未收录</Tag>
          </Tooltip>
        ),
    },
    {
      title: '人数',
      key: 'players',
      width: 88,
      render: (_, record) =>
        record.min_players != null && record.max_players != null ? (
          <span>
            {record.min_players}-{record.max_players} 人
          </span>
        ) : (
          <Cell>{null}</Cell>
        ),
    },
    {
      title: '时长',
      key: 'playtime',
      width: 96,
      render: (_, record) =>
        record.play_time_minutes != null ? (
          <span>
            {record.play_time_minutes} 分
            {record.min_playtime != null && record.max_playtime != null ? (
              <span style={{ color: 'var(--tm-text-tertiary)', fontSize: 11 }}>
                （{record.min_playtime}~{record.max_playtime}）
              </span>
            ) : null}
          </span>
        ) : (
          <Cell>{null}</Cell>
        ),
    },
    {
      title: '适龄',
      dataIndex: 'min_age',
      width: 68,
      render: (v?: number | null) => (typeof v === 'number' ? <span>{v}+</span> : <Cell>{null}</Cell>),
    },
    {
      title: '复杂度',
      dataIndex: 'complexity',
      width: 84,
      render: (v?: number | null) =>
        typeof v === 'number' ? (
          <Tag style={{ background: 'var(--tm-info-tint)', color: 'var(--tm-info)', border: 'none' }}>
            {v.toFixed(1)}
          </Tag>
        ) : (
          <Cell>{null}</Cell>
        ),
    },
    {
      title: '分类',
      dataIndex: 'categories',
      width: 130,
      render: (items?: string[] | null) => <TagList items={items} colorStyle="warm" />,
    },
    {
      title: '机制',
      dataIndex: 'mechanics',
      width: 130,
      render: (items?: string[] | null) => <TagList items={items} colorStyle="info" />,
    },
    {
      title: '设计 / 出版',
      key: 'credits',
      width: 150,
      render: (_, record) => (
        <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          <div className="tm-clamp-1">
            {record.designers?.length ? record.designers.join('、') : '设计师暂无数据'}
          </div>
          <div className="tm-clamp-1" style={{ color: 'var(--tm-text-secondary)' }}>
            {record.publisher || '出版社暂无数据'}
            {record.year_published != null ? ` · ${record.year_published}` : ''}
          </div>
        </div>
      ),
    },
    {
      title: '评分',
      key: 'rating',
      width: 118,
      render: (_, record) =>
        record.avg_rating != null ? (
          <span>
            <b style={{ color: 'var(--tm-rating)' }}>{record.avg_rating.toFixed(1)}</b>
            {record.rating_count != null && (
              <span style={{ color: 'var(--tm-text-tertiary)', fontSize: 12 }}>
                {' '}
                / {record.rating_count} 人
              </span>
            )}
          </span>
        ) : (
          <Cell>{null}</Cell>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
            style={{ paddingInline: 0 }}
          >
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={deletingId === record.id}
            onClick={() => confirmDelete(record)}
            style={{ paddingInline: 0 }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <AdminPageCard
      title="桌游管理"
      description="桌游资料的新增 / 编辑 / 删除；编辑弹窗内可直接上传规则书（PDF / 图片）供前台翻阅。"
      icon={<DatabaseOutlined />}
      extra={
        <>
          <Tooltip title="重新拉取列表">
            <Button icon={<ReloadOutlined />} onClick={list.reload} loading={list.loading} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增桌游
          </Button>
        </>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input
            allowClear
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            prefix={<SearchOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
            placeholder="搜索桌游名称"
            style={{ flex: 1, minWidth: 220, maxWidth: 380 }}
          />
          <Segmented
            value={sort}
            options={SORT_OPTIONS}
            onChange={(value) => {
              setSort(String(value));
              list.setPage(1);
              list.reload();
            }}
          />
        </div>

        {list.error && (
          <ErrorAlert error={list.error} onRetry={list.reload} description="桌游列表加载失败" />
        )}

        {list.loading ? (
          <TableSkeleton rows={6} />
        ) : (
          <Table<AdminGame>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={list.rows}
            scroll={{ x: 1520 }}
            locale={{
              emptyText: (
                <TableEmpty
                  keywordApplied={Boolean(list.search.trim())}
                  emptyText="暂无桌游数据"
                  searchText="没有匹配的桌游，试试更换关键词或关掉筛选"
                />
              ),
            }}
            pagination={pagedPagination(list)}
          />
        )}
      </Space>

      <Modal
        open={modalOpen}
        title={editing ? `编辑桌游 · ${editing.name}` : '新增桌游'}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        width={760}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        <Form<GameFormValues>
          key={formKey}
          form={form}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          initialValues={initialValues}
        >
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入桌游名称' }]}>
                <Input placeholder="中文名称" maxLength={200} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="英文名称" name="name_en">
                <Input placeholder="选填" maxLength={200} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="中文简介" name="description">
            <Input.TextArea rows={3} placeholder="选填" maxLength={2000} showCount />
          </Form.Item>

          <Form.Item
            label="封面图片地址"
            name="cover_image"
            extra={
              coverPreview ? (
                <img
                  src={coverPreview}
                  alt="封面预览"
                  style={{
                    marginTop: 8,
                    width: 72,
                    height: 72,
                    objectFit: 'cover',
                    borderRadius: 'var(--tm-radius-sm)',
                    border: '1px solid var(--tm-border)',
                  }}
                />
              ) : (
                '填写图片 URL，留空则展示无封面占位'
              )
            }
          >
            <Input
              placeholder="https://..."
              allowClear
              prefix={<PictureOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
              onChange={(e) => setCoverPreview(e.target.value)}
            />
          </Form.Item>

          <Divider orientation="left" plain style={{ fontSize: 12, margin: '4px 0' }}>
            玩法参数
          </Divider>
          <Row gutter={16}>
            <Col xs={12} sm={8}>
              <Form.Item label="最少人数" name="min_players">
                <InputNumber min={1} max={99} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item
                label="最多人数"
                name="max_players"
                dependencies={['min_players']}
                rules={[
                  ({ getFieldValue }) => ({
                    validator: (_rule, value) => {
                      const min = getFieldValue('min_players');
                      if (value == null || min == null || value >= min) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error('最多人数不能小于最少人数'));
                    },
                  }),
                ]}
              >
                <InputNumber min={1} max={99} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="标称时长（分钟）" name="play_time_minutes">
                <InputNumber min={1} max={10000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="时长下限（分钟）" name="min_playtime">
                <InputNumber min={1} max={10000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item
                label="时长上限（分钟）"
                name="max_playtime"
                dependencies={['min_playtime']}
                rules={[
                  ({ getFieldValue }) => ({
                    validator: (_rule, value) => {
                      const min = getFieldValue('min_playtime');
                      if (value == null || min == null || value >= min) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error('时长上限不能小于下限'));
                    },
                  }),
                ]}
              >
                <InputNumber min={1} max={10000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="最低年龄" name="min_age">
                <InputNumber min={0} max={99} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="复杂度（1~5）" name="complexity" extra="无可信来源时留空">
                <InputNumber min={1} max={5} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="发行年份" name="year_published">
                <InputNumber min={-3000} max={2100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain style={{ fontSize: 12, margin: '4px 0' }}>
            标签与创作信息
          </Divider>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="分类" name="categories">
                <Select
                  mode="tags"
                  allowClear
                  placeholder="可多选或直接输入新分类"
                  options={categoryOptions}
                  tokenSeparators={[',']}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="机制" name="mechanics">
                <Select
                  mode="tags"
                  allowClear
                  placeholder="可多选或直接输入新机制"
                  options={mechanicOptions}
                  tokenSeparators={[',']}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="设计师" name="designers">
                <Select mode="tags" allowClear placeholder="输入后回车添加" tokenSeparators={[',']} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="美术" name="artists">
                <Select mode="tags" allowClear placeholder="输入后回车添加" tokenSeparators={[',']} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain style={{ fontSize: 12, margin: '4px 0' }}>
            出版与来源
          </Divider>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="出版社" name="publisher">
                <Input placeholder="选填" maxLength={200} />
              </Form.Item>
            </Col>
            <Col xs={12} md={8}>
              <Form.Item label="BGG ID" name="bgg_id" extra="重复会被拒绝">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={8}>
              <Form.Item label="BGG 链接" name="bgg_url">
                <Input placeholder="https://boardgamegeek.com/..." allowClear />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label="备注（后台可见）"
            name="admin_note"
            extra="仅管理员可见的维护备注，不对外展示"
          >
            <Input.TextArea rows={2} placeholder="选填" maxLength={500} />
          </Form.Item>

          {editing && (
            <div
              style={{
                marginTop: 4,
                background: '#fafbfc',
                border: '1px solid var(--tm-border)',
                borderRadius: 10,
                padding: '10px 12px',
                fontSize: 12.5,
                color: 'var(--tm-text-secondary)',
                lineHeight: 1.8,
              }}
            >
              正在编辑「{editing.name}」（ID {editing.id}）；
              {editing.avg_rating != null
                ? `当前本站均分 ${editing.avg_rating.toFixed(2)}（${editing.rating_count ?? 0} 人评分）`
                : '尚未有玩家评分'}
              。以上字段已回填为库内原值，可直接在此基础上修改。
            </div>
          )}
        </Form>

        <Divider orientation="left" plain style={{ fontSize: 12, margin: '12px 0 10px' }}>
          规则说明书
        </Divider>

        {editing ? (
          <GameRuleBookPanel
            key={editing.id}
            gameId={editing.id}
            gameName={editing.name}
            onChanged={list.reload}
          />
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ borderRadius: 'var(--tm-radius-md)' }}
            message="桌游创建成功后，即可在编辑弹窗里上传规则书（PDF / 图片）供前台翻阅。"
          />
        )}
      </Modal>
    </AdminPageCard>
  );
}
