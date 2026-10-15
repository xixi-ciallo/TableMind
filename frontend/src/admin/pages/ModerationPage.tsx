import { useState } from 'react';
import { Button, Descriptions, Drawer, Modal, Space, Table, Tabs, Tag, Tooltip, message } from 'antd';
import type { TableColumnsType } from 'antd';
import { AuditOutlined, DeleteOutlined } from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import { ErrorAlert, TableEmpty, TableSkeleton } from '../components/AdminStates';
import { deleteModeration, fetchModeration } from '../adminApi';
import { listPagination, useAdminList } from '../useAdminList';
import type { AdminComment, AdminPost, AdminReview, ModerationKind } from '../adminTypes';

interface ModerationRow {
  id: number;
}

const TABS: { key: ModerationKind; label: string; hint: string }[] = [
  { key: 'reviews', label: '评测', hint: '用户对桌游的评分与长评，删除后不可恢复。' },
  { key: 'posts', label: '帖子', hint: '社区讨论帖，删除后不可恢复。' },
  { key: 'comments', label: '评论', hint: '帖子下方的评论，删除后不可恢复。' },
];

function formatTime(value?: string | null): string {
  if (!value) return '暂无数据';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 长文本在表格里截断展示，全文由 Tooltip 提供 */
function ContentCell({ text }: { text?: string | null }) {
  if (!text) return <span style={{ color: 'var(--tm-text-tertiary)' }}>暂无内容</span>;
  return (
    <Tooltip title={text} placement="topLeft">
      <span className="tm-clamp-2" style={{ maxWidth: 420, display: 'inline-block' }}>
        {text}
      </span>
    </Tooltip>
  );
}

function TimeCell({ value }: { value?: string | null }) {
  return <span style={{ color: 'var(--tm-text-secondary)' }}>{formatTime(value)}</span>;
}

/** 详情抽屉里的字段卡片：按分区类型挑出存在的字段，正文另起一块完整展示 */
function DetailBody({ record, kind }: { record: Record<string, unknown>; kind: ModerationKind }) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  const username = record.username as string | null | undefined;
  const userId = record.user_id as number | null | undefined;
  rows.push({
    label: '发布用户',
    value: username ? `${username}${userId != null ? `（ID ${userId}）` : ''}` : '暂无数据',
  });

  if (kind === 'reviews' || kind === 'posts') {
    const gameName = record.game_name as string | null | undefined;
    const gameId = record.game_id as number | null | undefined;
    rows.push({
      label: '关联桌游',
      value: gameName ? `${gameName}${gameId != null ? `（ID ${gameId}）` : ''}` : '未关联桌游',
    });
  }
  if (kind === 'comments') {
    const postTitle = record.post_title as string | null | undefined;
    const postId = record.post_id as number | null | undefined;
    rows.push({
      label: '所属帖子',
      value: postTitle ? `${postTitle}${postId != null ? `（ID ${postId}）` : ''}` : '暂无数据',
    });
  }
  if (kind === 'reviews') {
    const rating = record.rating as number | null | undefined;
    if (typeof rating === 'number') rows.push({ label: '评分', value: <Tag color="volcano">{rating}</Tag> });
  }
  if (kind === 'posts') {
    const title = record.title as string | null | undefined;
    if (title) rows.push({ label: '标题', value: title });
  }
  rows.push({ label: '发布时间', value: formatTime(record.created_at as string | null | undefined) });

  const content = (record.content as string | null | undefined) ?? '';

  return (
    <div>
      <Descriptions column={1} size="small" bordered>
        {rows.map((r) => (
          <Descriptions.Item key={r.label} label={r.label}>
            {r.value}
          </Descriptions.Item>
        ))}
      </Descriptions>
      <div style={{ marginTop: 16, fontSize: 13, color: 'var(--tm-text-secondary)', marginBottom: 6 }}>
        内容全文
      </div>
      <div
        style={{
          border: '1px solid var(--tm-border)',
          borderRadius: 10,
          padding: '12px 14px',
          background: '#fafbfc',
          fontSize: 13.5,
          lineHeight: 1.8,
          color: '#374151',
          whiteSpace: 'pre-wrap',
          maxHeight: 440,
          overflow: 'auto',
        }}
      >
        {content ? content : '（无内容）'}
      </div>
    </div>
  );
}

/**
 * 单个分区的审核列表。
 * 三个分区各自持有独立的加载 / 分页状态，互不干扰。
 */
function ModerationList<T extends ModerationRow>({
  kind,
  columns,
}: {
  kind: ModerationKind;
  columns: TableColumnsType<T>;
}) {
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [detail, setDetail] = useState<T | null>(null);
  const list = useAdminList<T>(({ page, pageSize }) =>
    fetchModeration<T>(kind, { page, pageSize }),
  );

  const confirmDelete = (record: T) => {
    Modal.confirm({
      title: '确认删除该内容？',
      content: (
        <span>
          即将删除 ID 为 <b>{record.id}</b> 的内容，删除后不可恢复。
        </span>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeletingId(record.id);
        try {
          await deleteModeration(kind, record.id);
          message.success('内容已删除');
          list.reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败');
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  const actionColumn: TableColumnsType<T> = [
    {
      title: '操作',
      key: 'action',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => setDetail(record)}
          >
            详情
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
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      {list.error && (
        <ErrorAlert error={list.error} onRetry={list.reload} description="待审核内容加载失败" />
      )}

      {list.loading ? (
        <TableSkeleton rows={5} />
      ) : (
        <Table<T>
          rowKey="id"
          size="middle"
          columns={[...columns, ...actionColumn]}
          dataSource={list.rows}
          scroll={{ x: 900 }}
          locale={{ emptyText: <TableEmpty emptyText="暂无内容" searchText="没有匹配的内容" /> }}
          pagination={listPagination(list)}
        />
      )}
      <Drawer
        title={
          detail
            ? `${kind === 'reviews' ? '评测' : kind === 'posts' ? '帖子' : '评论'}详情 · ID ${detail.id ?? ''}`
            : '详情'
        }
        open={!!detail}
        onClose={() => setDetail(null)}
        width={560}
      >
        {detail && (
          <DetailBody record={detail as unknown as Record<string, unknown>} kind={kind} />
        )}
      </Drawer>
    </Space>
  );
}

const reviewColumns: TableColumnsType<AdminReview> = [
  { title: 'ID', dataIndex: 'id', width: 64, render: (v?: number | null) => v ?? '暂无数据' },
  {
    title: '用户',
    dataIndex: 'username',
    width: 132,
    render: (v?: string | null, record?: AdminReview) => (
      <div style={{ minWidth: 0 }}>
        <div className="tm-clamp-1">{v || '暂无数据'}</div>
        {record?.user_id != null && (
          <div style={{ fontSize: 11, color: 'var(--tm-text-tertiary)' }}>ID {record.user_id}</div>
        )}
      </div>
    ),
  },
  {
    title: '桌游',
    dataIndex: 'game_name',
    width: 150,
    render: (v?: string | null, record?: AdminReview) => (
      <div style={{ minWidth: 0 }}>
        <div className="tm-clamp-1">{v || '暂无数据'}</div>
        {record?.game_id != null && (
          <div style={{ fontSize: 11, color: 'var(--tm-text-tertiary)' }}>ID {record.game_id}</div>
        )}
      </div>
    ),
  },
  {
    title: '评分',
    dataIndex: 'rating',
    width: 88,
    render: (v?: number | null) =>
      typeof v === 'number' ? (
        <Tag style={{ background: 'var(--tm-tint)', color: 'var(--tm-rating)', border: 'none' }}>
          {v}
        </Tag>
      ) : (
        '暂无数据'
      ),
  },
  {
    title: '评测内容',
    dataIndex: 'content',
    render: (_: unknown, record) => <ContentCell text={record.content} />,
  },
  {
    title: '发布时间',
    dataIndex: 'created_at',
    width: 168,
    render: (v?: string | null) => <TimeCell value={v} />,
  },
];

const postColumns: TableColumnsType<AdminPost> = [
  { title: 'ID', dataIndex: 'id', width: 64, render: (v?: number | null) => v ?? '暂无数据' },
  {
    title: '用户',
    dataIndex: 'username',
    width: 132,
    render: (v?: string | null, record?: AdminPost) => (
      <div style={{ minWidth: 0 }}>
        <div className="tm-clamp-1">{v || '暂无数据'}</div>
        {record?.user_id != null && (
          <div style={{ fontSize: 11, color: 'var(--tm-text-tertiary)' }}>ID {record.user_id}</div>
        )}
      </div>
    ),
  },
  {
    title: '关联桌游',
    dataIndex: 'game_name',
    width: 150,
    render: (v?: string | null) => (
      <span className="tm-clamp-1">{v || '未关联桌游'}</span>
    ),
  },
  {
    title: '标题',
    dataIndex: 'title',
    width: 200,
    ellipsis: true,
    render: (v?: string | null) => v || '暂无数据',
  },
  {
    title: '正文',
    dataIndex: 'content',
    render: (_: unknown, record) => <ContentCell text={record.content} />,
  },
  {
    title: '发布时间',
    dataIndex: 'created_at',
    width: 168,
    render: (v?: string | null) => <TimeCell value={v} />,
  },
];

const commentColumns: TableColumnsType<AdminComment> = [
  { title: 'ID', dataIndex: 'id', width: 64, render: (v?: number | null) => v ?? '暂无数据' },
  {
    title: '所属帖子',
    dataIndex: 'post_title',
    width: 170,
    render: (v?: string | null, record?: AdminComment) => (
      <div style={{ minWidth: 0 }}>
        <div className="tm-clamp-1">{v || '暂无数据'}</div>
        {record?.post_id != null && (
          <div style={{ fontSize: 11, color: 'var(--tm-text-tertiary)' }}>帖子 ID {record.post_id}</div>
        )}
      </div>
    ),
  },
  {
    title: '用户',
    dataIndex: 'username',
    width: 132,
    render: (v?: string | null, record?: AdminComment) => (
      <div style={{ minWidth: 0 }}>
        <div className="tm-clamp-1">{v || '暂无数据'}</div>
        {record?.user_id != null && (
          <div style={{ fontSize: 11, color: 'var(--tm-text-tertiary)' }}>ID {record.user_id}</div>
        )}
      </div>
    ),
  },
  {
    title: '评论内容',
    dataIndex: 'content',
    render: (_: unknown, record) => <ContentCell text={record.content} />,
  },
  {
    title: '发布时间',
    dataIndex: 'created_at',
    width: 168,
    render: (v?: string | null) => <TimeCell value={v} />,
  },
];

export default function ModerationPage() {
  const [active, setActive] = useState<ModerationKind>('reviews');

  return (
    <AdminPageCard
      title="内容审核"
      description="评测 / 帖子 / 评论三个分区分别调用各自的接口，删除操作不可恢复。"
      icon={<AuditOutlined />}
    >
      <Tabs
        activeKey={active}
        onChange={(key) => setActive(key as ModerationKind)}
        destroyInactiveTabPane
        items={TABS.map((tab) => ({
          key: tab.key,
          label: tab.label,
          children: (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--tm-text-secondary)' }}>
                {tab.hint}
              </p>
              {tab.key === 'reviews' && <ModerationList<AdminReview> kind="reviews" columns={reviewColumns} />}
              {tab.key === 'posts' && <ModerationList<AdminPost> kind="posts" columns={postColumns} />}
              {tab.key === 'comments' && <ModerationList<AdminComment> kind="comments" columns={commentColumns} />}
            </div>
          ),
        }))}
      />
    </AdminPageCard>
  );
}
