import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  TagsOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import { ErrorAlert, TableEmpty, TableSkeleton } from '../components/AdminStates';
import { createTag, deleteTag, fetchTags, syncTags, updateTag } from '../adminApi';
import type { AdminTag, AdminTagPayload, AdminTagType } from '../adminTypes';

interface TagFormValues {
  name: string;
  type: AdminTagType;
}

type FilterValue = 'all' | AdminTagType;

const TYPE_LABEL: Record<string, string> = {
  category: '分类',
  mechanic: '机制',
};

const TYPE_COLOR: Record<string, { bg: string; fg: string }> = {
  category: { bg: 'var(--tm-tint)', fg: 'var(--tm-action)' },
  mechanic: { bg: 'var(--tm-info-tint)', fg: 'var(--tm-info)' },
};

/** 后端 TagOut.type 是字符串，做一次收敛，未知值按分类处理但如实展示原值 */
function normalizeType(value: string): AdminTagType {
  return value === 'mechanic' ? 'mechanic' : 'category';
}

export default function TagManagePage() {
  const [typeFilter, setTypeFilter] = useState<FilterValue>('all');
  const [keyword, setKeyword] = useState('');
  const [tags, setTags] = useState<AdminTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [form] = Form.useForm<TagFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminTag | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  // GET /api/admin/tags 返回每个标签的 usage_count（被多少款桌游引用）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    fetchTags(typeFilter === 'all' ? undefined : typeFilter)
      .then((data) => {
        if (alive) setTags(data);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setTags([]);
        setError(e instanceof Error ? e.message : '标签列表加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [typeFilter, reloadToken]);

  /** 打开编辑面板时把原有信息带进表单 */
  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: typeFilter === 'mechanic' ? 'mechanic' : 'category' });
    setModalOpen(true);
  };

  const openEdit = (record: AdminTag) => {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue({ name: record.name, type: normalizeType(record.type) });
    setModalOpen(true);
  };

  const submit = async () => {
    let values: TagFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 校验未通过：由表单自身展示错误提示
      return;
    }

    const payload: AdminTagPayload = {
      name: values.name.trim(),
      type: values.type,
    };
    if (!payload.name) {
      message.error('标签名称不能为空');
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        await updateTag(editing.id, payload);
        message.success('已保存标签修改');
      } else {
        await createTag(payload);
        message.success('已新增标签');
      }
      setModalOpen(false);
      reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 从桌游库重新同步标签：新增缺失标签 + 补齐已有标签 */
  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await syncTags();
      const created = res?.created ?? 0;
      const updated = res?.updated ?? 0;
      message.success(
        `标签同步完成：新增 ${created} 个${updated ? `，更新 ${updated} 个` : ''}`,
      );
      reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '标签同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const confirmDelete = (record: AdminTag) => {
    const usage = record.usage_count ?? 0;
    const typeLabel = TYPE_LABEL[normalizeType(record.type)] ?? record.type;

    Modal.confirm({
      title: '确认删除该标签？',
      width: 480,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--tm-text-secondary)' }}>
          <p style={{ margin: '0 0 8px' }}>
            标签「<b style={{ color: 'var(--tm-text-primary)' }}>{record.name}</b>」（{typeLabel}）
            删除后，已引用该标签的桌游会失去这一条关联。
          </p>
          {usage > 0 && (
            <p
              style={{
                margin: 0,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--tm-warn-tint)',
                color: 'var(--tm-warn)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <WarningOutlined />
              有 <b>{usage}</b> 款桌游正在引用该标签，删除会影响它们的分类 / 机制展示。
            </p>
          )}
        </div>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeletingId(record.id);
        try {
          await deleteTag(record.id);
          message.success('标签已删除');
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败');
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(kw));
  }, [tags, keyword]);

  /** 使用量分布统计（本地计算，供页面概览展示） */
  const stats = useMemo(() => {
    const used = tags.filter((t) => (t.usage_count ?? 0) > 0).length;
    return {
      total: tags.length,
      category: tags.filter((t) => normalizeType(t.type) === 'category').length,
      mechanic: tags.filter((t) => normalizeType(t.type) === 'mechanic').length,
      used,
      unused: tags.length - used,
    };
  }, [tags]);

  const columns: TableColumnsType<AdminTag> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 74,
      render: (v: number) => <span style={{ color: 'var(--tm-text-secondary)' }}>{v}</span>,
    },
    {
      title: '标签名称',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string) => <span style={{ fontWeight: 600, color: 'var(--tm-text-primary)' }}>{v}</span>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 96,
      render: (v: string) => {
        const type = normalizeType(v);
        const c = TYPE_COLOR[type];
        return (
          <Tag style={{ background: c.bg, color: c.fg, border: 'none', marginInlineEnd: 0 }}>
            {TYPE_LABEL[type]}
          </Tag>
        );
      },
    },
    {
      title: '使用量',
      dataIndex: 'usage_count',
      width: 140,
      sorter: (a, b) => (a.usage_count ?? 0) - (b.usage_count ?? 0),
      defaultSortOrder: 'descend',
      render: (v: number | undefined) => {
        const n = v ?? 0;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 34,
                height: 20,
                paddingInline: 6,
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
                background: n > 0 ? 'var(--tm-tint)' : '#f3f4f6',
                color: n > 0 ? 'var(--tm-action)' : 'var(--tm-text-tertiary)',
              }}
            >
              {n}
            </span>
            <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>款桌游引用</span>
          </span>
        );
      },
    },
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
      title="标签管理"
      description="桌游分类（如德式 / 聚会）与机制（如卡牌构筑 / 工人放置）标签的增删改查。使用量按桌游 JSONB 字段中的真实引用次数统计；改名前可预览级联影响。"
      icon={<TagsOutlined />}
      extra={
        <>
          <Tooltip title="从桌游库重新拉取标签，补齐缺失标签">
            <Button icon={<SyncOutlined />} loading={syncing} onClick={handleSync}>
              同步标签
            </Button>
          </Tooltip>
          <Tooltip title="重新拉取标签">
            <Button icon={<ReloadOutlined />} onClick={reload} loading={loading} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增标签
          </Button>
        </>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {/* 概览 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 12,
          }}
        >
          <OverviewTile label="标签总数" value={stats.total} />
          <OverviewTile label="分类标签" value={stats.category} />
          <OverviewTile label="机制标签" value={stats.mechanic} />
          <OverviewTile label="被引用标签" value={stats.used} tone="action" />
          <OverviewTile label="未使用" value={stats.unused} tone="tertiary" />
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            prefix={<SearchOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
            placeholder="搜索标签名称"
            style={{ flex: 1, minWidth: 220, maxWidth: 320 }}
          />
          <Segmented<FilterValue>
            value={typeFilter}
            onChange={setTypeFilter}
            options={[
              { label: '全部', value: 'all' },
              { label: '分类', value: 'category' },
              { label: '机制', value: 'mechanic' },
            ]}
          />
        </div>

        {error && <ErrorAlert error={error} onRetry={reload} description="标签列表加载失败" />}

        {loading ? (
          <TableSkeleton rows={5} />
        ) : (
          <Table<AdminTag>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 620 }}
            locale={{ emptyText: <TableEmpty emptyText="暂无标签数据" /> }}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              hideOnSinglePage: true,
              showTotal: (total) => `共 ${total} 个标签`,
            }}
          />
        )}
      </Space>

      <Modal
        open={modalOpen}
        title={editing ? `编辑标签 · ${editing.name}` : '新增标签'}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        <Form<TagFormValues> form={form} layout="vertical" requiredMark={false} preserve={false}>
          <Form.Item
            label="标签名称"
            name="name"
            rules={[
              { required: true, message: '请输入标签名称' },
              { max: 100, message: '最多 100 个字符' },
            ]}
          >
            <Input placeholder="例如：德式 / 工人放置" maxLength={100} />
          </Form.Item>
          <Form.Item
            label="标签类型"
            name="type"
            rules={[{ required: true, message: '请选择标签类型' }]}
          >
            <Segmented<AdminTagType>
              options={[
                { label: '分类', value: 'category' },
                { label: '机制', value: 'mechanic' },
              ]}
            />
          </Form.Item>

          {editing && (
            <div
              style={{
                marginTop: 4,
                padding: '10px 12px',
                background: '#fafbfc',
                border: '1px solid var(--tm-border)',
                borderRadius: 10,
                fontSize: 12.5,
                color: 'var(--tm-text-secondary)',
                lineHeight: 1.8,
              }}
            >
              正在编辑「{editing.name}」（ID {editing.id}），已
              {(editing.usage_count ?? 0) > 0 ? `被 ${editing.usage_count} 款桌游引用` : '暂未被任何桌游引用'}
              。改名时后端会同步更新所有引用该标签的桌游字段。
            </div>
          )}
        </Form>
      </Modal>
    </AdminPageCard>
  );
}

function OverviewTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'action' | 'tertiary';
}) {
  const color =
    tone === 'action' ? 'var(--tm-action)' : tone === 'tertiary' ? 'var(--tm-text-tertiary)' : 'var(--tm-text-primary)';
  return (
    <div
      style={{
        background: 'var(--tm-surface-card)',
        border: '1px solid var(--tm-border)',
        borderRadius: 'var(--tm-radius-md)',
        padding: '12px 14px',
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 12.5, color: 'var(--tm-text-secondary)', marginTop: 2 }}>{label}</div>
    </div>
  );
}
