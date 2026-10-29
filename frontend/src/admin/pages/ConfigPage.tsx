/**
 * P4 系统配置中心
 *
 * 数据库覆盖 .env：保存后立即作用于当前后端进程，无需重启。
 * 只展示后端白名单里的参数——API Key、数据库地址这类结构性配置永远只能走 .env。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  HistoryOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import { ErrorAlert, TableSkeleton } from '../components/AdminStates';
import {
  fetchConfigAudits,
  fetchRuntimeConfigs,
  resetRuntimeConfig,
  rollbackConfigAudit,
  updateRuntimeConfig,
} from '../adminApi';
import type { ConfigAuditItem, ConfigValue, RuntimeConfigItem } from '../adminTypes';

type DraftMap = Record<string, ConfigValue | null>;

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function actionTag(action: string) {
  if (action === 'set') return <Tag color="blue">修改</Tag>;
  if (action === 'reset') return <Tag>恢复默认</Tag>;
  if (action === 'rollback') return <Tag color="gold">回滚</Tag>;
  return <Tag>{action}</Tag>;
}

/** 按 kind 渲染对应的输入控件；数字框清空时不允许提交 null */
function ValueControl({
  item,
  value,
  onChange,
}: {
  item: RuntimeConfigItem;
  value: ConfigValue | null;
  onChange: (next: ConfigValue) => void;
}) {
  if (item.kind === 'bool') {
    return (
      <Switch
        checked={Boolean(value)}
        onChange={onChange}
        checkedChildren="开"
        unCheckedChildren="关"
      />
    );
  }
  if (item.kind === 'enum') {
    return (
      <Select
        value={String(value ?? '')}
        onChange={onChange}
        options={(item.options || []).map((opt) => ({ label: opt, value: opt }))}
        style={{ minWidth: 150 }}
      />
    );
  }
  if (item.kind === 'int' || item.kind === 'float') {
    const num =
      typeof value === 'number'
        ? value
        : value === '' || value === null || value === undefined
          ? null
          : Number(value);
    return (
      <InputNumber
        value={Number.isFinite(num as number) ? num : null}
        min={item.minimum ?? undefined}
        max={item.maximum ?? undefined}
        step={item.kind === 'int' ? 1 : item.step ?? 0.1}
        precision={item.kind === 'int' ? 0 : undefined}
        onChange={(next) => {
          if (next !== null) onChange(next);
        }}
        style={{ width: 140 }}
      />
    );
  }
  return (
    <Input
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder={
        item.default === '' ? '留空表示不指定' : `留空跟随默认（${String(item.default)}）`
      }
      allowClear
      style={{ width: 260 }}
    />
  );
}

export default function ConfigPage() {
  const [items, setItems] = useState<RuntimeConfigItem[]>([]);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [auditKey, setAuditKey] = useState<string | null>(null);
  const [audits, setAudits] = useState<ConfigAuditItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRuntimeConfigs();
      setItems(data);
      setDrafts(Object.fromEntries(data.map((item) => [item.key, item.value])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const order: string[] = [];
    items.forEach((item) => {
      if (!order.includes(item.group)) order.push(item.group);
    });
    return order;
  }, [items]);

  const overridden = items.filter((item) => item.source === 'db').length;

  const isDirty = (item: RuntimeConfigItem) =>
    JSON.stringify(drafts[item.key] ?? null) !== JSON.stringify(item.value ?? null);

  const loadAudits = useCallback(async (key: string) => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      setAudits(await fetchConfigAudits(key));
    } catch (e) {
      setAuditError((e as Error).message);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const openAudit = (key: string) => {
    setAuditKey(key);
    void loadAudits(key);
  };

  const handleSave = async (item: RuntimeConfigItem) => {
    const next = drafts[item.key];
    if (next === null || next === undefined) {
      message.warning('请填写有效值后再保存');
      return;
    }
    setSavingKey(item.key);
    try {
      await updateRuntimeConfig(item.key, next);
      message.success(`${item.label} 已生效`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const handleReset = async (item: RuntimeConfigItem) => {
    setSavingKey(item.key);
    try {
      await resetRuntimeConfig(item.key);
      message.success(`${item.label} 已恢复 .env 默认值`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const handleRollback = async (audit: ConfigAuditItem) => {
    try {
      await rollbackConfigAudit(audit.id);
      message.success('已回滚到该记录之前的取值');
      if (auditKey) await loadAudits(auditKey);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const auditColumns: TableColumnsType<ConfigAuditItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 165,
      render: (value: string) => formatTime(value),
    },
    {
      title: '操作',
      dataIndex: 'action',
      width: 92,
      render: (value: string) => actionTag(value),
    },
    {
      title: '变更',
      render: (_, record) => (
        <span style={{ fontSize: 12, wordBreak: 'break-all' }}>
          <code>{record.old_value === '' || record.old_value === null ? '—' : record.old_value}</code>
          {' → '}
          <code>{record.new_value === '' || record.new_value === null ? '（空）' : record.new_value}</code>
        </span>
      ),
    },
    {
      title: '操作人',
      dataIndex: 'operator_name',
      width: 100,
      render: (value: string | null) => value || '—',
    },
    {
      title: '',
      width: 78,
      render: (_, record) => (
        <Popconfirm
          title="回滚到这条记录之前的取值？"
          description="回滚会再记一条变更记录，可继续回滚。"
          okText="回滚"
          cancelText="取消"
          onConfirm={() => handleRollback(record)}
        >
          <Button size="small" type="link" icon={<UndoOutlined />}>
            回滚
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const auditTitle =
    items.find((item) => item.key === auditKey)?.label ?? auditKey ?? '变更记录';

  const renderRow = (item: RuntimeConfigItem) => {
    const dirty = isDirty(item);
    return (
      <div
        key={item.key}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          padding: '14px 0',
          borderBottom: '1px solid var(--tm-border)',
          alignItems: 'center',
        }}
      >
        <div style={{ flex: '1 1 320px', minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--tm-text-primary)' }}>{item.label}</span>
            <Tag style={{ marginInlineEnd: 0 }}>{item.key}</Tag>
            {item.source === 'db' ? (
              <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                数据库覆盖
              </Tag>
            ) : (
              <Tag style={{ marginInlineEnd: 0 }}>.env</Tag>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--tm-text-secondary)',
              lineHeight: 1.7,
              marginTop: 5,
            }}
          >
            {item.description}
          </div>
          {item.source === 'db' && item.updated_at && (
            <div style={{ fontSize: 12, color: 'var(--tm-text-secondary)', marginTop: 3 }}>
              最近修改：{item.updated_by_name || '未知'} · {formatTime(item.updated_at)} · 默认值{' '}
              {String(item.default) || '（空）'}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <ValueControl
            item={item}
            value={drafts[item.key] ?? null}
            onChange={(next) => setDrafts((prev) => ({ ...prev, [item.key]: next }))}
          />
          <Button
            type="primary"
            size="small"
            icon={<SaveOutlined />}
            disabled={!dirty}
            loading={savingKey === item.key}
            onClick={() => handleSave(item)}
          >
            保存
          </Button>
          <Popconfirm
            title="恢复 .env 默认值？"
            description="会删除数据库覆盖，立即生效。"
            okText="恢复"
            cancelText="取消"
            disabled={item.source !== 'db'}
            onConfirm={() => handleReset(item)}
          >
            <Button size="small" disabled={item.source !== 'db'}>
              恢复默认
            </Button>
          </Popconfirm>
          <Button
            size="small"
            type="link"
            icon={<HistoryOutlined />}
            onClick={() => openAudit(item.key)}
          >
            记录
          </Button>
        </div>
      </div>
    );
  };

  return (
    <AdminPageCard
      title="系统配置"
      icon={<SettingOutlined />}
      description="在线调整检索、生成与评测参数：保存后立即生效，不需要重启后端；未调整的参数继续读取 .env，所有改动都有变更记录可回滚。"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      }
    >
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}

      {loading && items.length === 0 ? (
        <TableSkeleton rows={8} />
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可在线调整的配置项" />
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--tm-text-secondary)', marginBottom: 6 }}>
            共 {items.length} 项可调参数，其中 {overridden} 项已被数据库覆盖；其余读取 .env。
          </div>
          <Tabs
            items={groups.map((group) => ({
              key: group,
              label: group,
              children: <div>{items.filter((item) => item.group === group).map(renderRow)}</div>,
            }))}
          />
        </>
      )}

      <Drawer
        title={`变更记录 · ${auditTitle}`}
        width={720}
        open={Boolean(auditKey)}
        onClose={() => setAuditKey(null)}
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => auditKey && void loadAudits(auditKey)}
            loading={auditLoading}
          >
            刷新
          </Button>
        }
      >
        {auditError && (
          <ErrorAlert
            error={auditError}
            onRetry={() => auditKey && void loadAudits(auditKey)}
            description="变更记录加载失败"
          />
        )}
        {auditLoading ? (
          <TableSkeleton rows={4} />
        ) : audits.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该参数还没有变更记录" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={audits}
            columns={auditColumns}
          />
        )}
      </Drawer>
    </AdminPageCard>
  );
}
