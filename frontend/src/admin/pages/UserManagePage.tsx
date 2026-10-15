import { useCallback, useState } from 'react';
import {
  Badge,
  Button,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckCircleOutlined,
  CrownOutlined,
  IdcardOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import AdminPageCard from '../AdminPageCard';
import { ErrorAlert, TableEmpty, TableSkeleton } from '../components/AdminStates';
import {
  fetchUserDetail,
  fetchUsers,
  setUserRole,
  setUserStatus,
} from '../adminApi';
import { pagedPagination, useAdminPagedList } from '../useAdminList';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../shared/types';
import type { AdminUserDetail } from '../adminTypes';

/** 后端返回的时间格式不固定，统一成可读文案；解析失败显示原始值而不是伪造时间 */
function formatTime(value?: string | null): string {
  if (!value) return '暂无数据';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

const ROLE_FILTERS: { label: string; value: string }[] = [
  { label: '全部', value: '' },
  { label: '普通用户', value: 'user' },
  { label: '管理员', value: 'admin' },
];

export default function UserManagePage() {
  const { user: me } = useAuthStore();
  const [actingId, setActingId] = useState<number | null>(null);
  const [roleFilter, setRoleFilter] = useState('');

  /** 详情抽屉 */
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const list = useAdminPagedList<User>(
    ({ page, pageSize, search }) =>
      fetchUsers({ page, pageSize, q: search, role: roleFilter || undefined }),
    { pageSize: 10 },
  );

  const openDetail = useCallback(async (record: User) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await fetchUserDetail(record.id));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '获取用户详情失败');
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleToggle = useCallback(
    (user: User) => {
      const nextActive = !user.is_active;
      Modal.confirm({
        title: nextActive ? '确认启用该账号？' : '确认禁用该账号？',
        content: (
          <span>
            用户「{user.username}」（ID {user.id}）
            {nextActive ? '将恢复登录权限。' : '将无法登录，且其发布的内容可能受影响。'}
          </span>
        ),
        okText: nextActive ? '启用' : '禁用',
        okButtonProps: { danger: !nextActive },
        cancelText: '取消',
        onOk: async () => {
          setActingId(user.id);
          try {
            await setUserStatus(user.id, nextActive);
            message.success(nextActive ? '已启用该账号' : '已禁用该账号');
            list.reload();
          } catch (e) {
            message.error(e instanceof Error ? e.message : '操作失败');
          } finally {
            setActingId(null);
          }
        },
      });
    },
    [list],
  );

  const handleRole = useCallback(
    (user: User) => {
      const promote = user.role !== 'admin';
      Modal.confirm({
        title: promote ? '确认设为管理员？' : '确认取消管理员身份？',
        content: (
          <span>
            用户「{user.username}」（ID {user.id}）
            {promote ? '将获得后台全部管理权限。' : '将失去后台访问权限。'}
          </span>
        ),
        okText: promote ? '设为管理员' : '取消管理员',
        okButtonProps: { danger: !promote },
        cancelText: '取消',
        onOk: async () => {
          setActingId(user.id);
          try {
            await setUserRole(user.id, promote ? 'admin' : 'user');
            message.success(promote ? '已设为管理员' : '已取消管理员身份');
            list.reload();
          } catch (e) {
            message.error(e instanceof Error ? e.message : '操作失败');
          } finally {
            setActingId(null);
          }
        },
      });
    },
    [list],
  );

  const columns: TableColumnsType<User> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 64,
      render: (v: number) => <span style={{ color: 'var(--tm-text-secondary)' }}>{v}</span>,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      width: 150,
      render: (v: string, record) => (
        <Space size={6}>
          <span style={{ fontWeight: 600 }}>{v}</span>
          {record.id === me?.id && <Tag color="volcano">本人</Tag>}
        </Space>
      ),
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      width: 140,
      render: (v?: string | null) => v || '暂无数据',
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 96,
      render: (v: User['role']) =>
        v === 'admin' ? (
          <Tag color="volcano" icon={<CrownOutlined />}>
            管理员
          </Tag>
        ) : (
          <Tag>普通用户</Tag>
        ),
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      width: 96,
      render: (v: boolean) =>
        v ? <Badge status="success" text="正常" /> : <Badge status="error" text="已禁用" />,
    },
    {
      title: '注册时间',
      dataIndex: 'created_at',
      width: 176,
      render: (v?: string | null) => (
        <span style={{ color: 'var(--tm-text-secondary)' }}>{formatTime(v)}</span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button
            type="link"
            size="small"
            icon={<UserOutlined />}
            onClick={() => void openDetail(record)}
            style={{ paddingInline: 0 }}
          >
            详情
          </Button>
          <Button
            type="link"
            size="small"
            danger={record.is_active}
            icon={record.is_active ? <StopOutlined /> : <CheckCircleOutlined />}
            loading={actingId === record.id}
            onClick={() => handleToggle(record)}
            style={{ paddingInline: 0 }}
          >
            {record.is_active ? '禁用' : '启用'}
          </Button>
          <Tooltip
            title={
              record.id === me?.id
                ? '不能修改自己的角色'
                : record.role === 'admin'
                  ? '取消管理员身份'
                  : '设为管理员'
            }
          >
            <Button
              type="link"
              size="small"
              icon={<CrownOutlined />}
              disabled={record.id === me?.id}
              loading={actingId === record.id}
              onClick={() => handleRole(record)}
              style={{ paddingInline: 0 }}
            >
              {record.role === 'admin' ? '撤权限' : '提权限'}
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <AdminPageCard
      title="用户管理"
      description="用户列表支持按用户名 / 手机号搜索与角色筛选，可查看详情、禁用 / 启用账号、调整管理员权限。"
      icon={<IdcardOutlined />}
      extra={
        <Tooltip title="重新拉取用户列表">
          <Button icon={<ReloadOutlined />} onClick={list.reload} loading={list.loading}>
            刷新
          </Button>
        </Tooltip>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input
            allowClear
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            prefix={<SearchOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
            placeholder="搜索用户名或手机号"
            style={{ flex: 1, minWidth: 200, maxWidth: 320 }}
          />
          <Segmented
            value={roleFilter}
            options={ROLE_FILTERS}
            onChange={(v) => {
              setRoleFilter(String(v));
              list.setPage(1);
              list.reload();
            }}
          />
          <span style={{ fontSize: 12.5, color: 'var(--tm-text-secondary)' }}>
            共 {list.total} 个账号{list.search.trim() || roleFilter ? '（已筛选）' : ''}
          </span>
        </div>

        {list.error && <ErrorAlert error={list.error} onRetry={list.reload} description="用户列表加载失败" />}

        {list.loading ? (
          <TableSkeleton rows={6} />
        ) : (
          <Table<User>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={list.rows}
            scroll={{ x: 940 }}
            locale={{
              emptyText: (
                <TableEmpty
                  keywordApplied={Boolean(list.search.trim()) || Boolean(roleFilter)}
                  emptyText="暂无用户数据"
                  searchText="没有匹配的用户，试试更换关键词"
                />
              ),
            }}
            pagination={pagedPagination(list)}
          />
        )}
      </Space>

      <Drawer
        title={detail ? `用户详情 · ${detail.username}` : '用户详情'}
        open={detailOpen}
        width={420}
        onClose={() => setDetailOpen(false)}
      >
        {detailLoading || !detail ? (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="ID">{detail.id}</Descriptions.Item>
            <Descriptions.Item label="用户名">{detail.username}</Descriptions.Item>
            <Descriptions.Item label="手机号">{detail.phone || '暂无数据'}</Descriptions.Item>
            <Descriptions.Item label="角色">
              {detail.role === 'admin' ? '管理员' : '普通用户'}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              {detail.is_active ? (
                <Badge status="success" text="正常" />
              ) : (
                <Badge status="error" text="已禁用" />
              )}
            </Descriptions.Item>
            <Descriptions.Item label="个人简介">
              {detail.bio || <span style={{ color: 'var(--tm-text-tertiary)' }}>暂未填写</span>}
            </Descriptions.Item>
            <Descriptions.Item label="注册时间">{formatTime(detail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="发布评测">{detail.review_count} 条</Descriptions.Item>
            <Descriptions.Item label="发布帖子">{detail.post_count} 条</Descriptions.Item>
            <Descriptions.Item label="收藏桌游">{detail.collection_count} 款</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </AdminPageCard>
  );
}
