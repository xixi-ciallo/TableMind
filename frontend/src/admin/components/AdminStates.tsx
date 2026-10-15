/**
 * 管理端列表的统一状态呈现：加载骨架 / 错误（可重试）/ 空态。
 * 所有可见文案都基于真实接口结果，不出现任何占位数字或示例数据。
 */
import { Alert, Button, Empty, Result, Skeleton } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

/** 表格加载骨架：行数与列表默认页大小接近，避免内容跳变 */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: '8px 2px 4px' }}>
      <Skeleton active title={false} paragraph={{ rows, width: '100%' }} />
    </div>
  );
}

/** 卡片区加载骨架（仪表盘等栅格页面） */
export function CardGridSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
        gap: 14,
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            background: 'var(--tm-surface-card)',
            border: '1px solid var(--tm-border)',
            borderRadius: 'var(--tm-radius-lg)',
            padding: 18,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div
            className="tm-skeleton"
            style={{ width: 44, height: 44, borderRadius: 'var(--tm-radius-md)', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div className="tm-skeleton" style={{ height: 20, width: '52%' }} />
            <div className="tm-skeleton" style={{ height: 12, width: '34%', marginTop: 9 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 列表上方的错误提示条，带重试按钮 */
export function ErrorAlert({
  error,
  onRetry,
  description,
}: {
  error: string;
  onRetry: () => void;
  description?: string;
}) {
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 14, borderRadius: 'var(--tm-radius-md)' }}
      message={description ?? '数据加载失败'}
      description={error}
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
          重试
        </Button>
      }
    />
  );
}

/** 整页级错误（统计面板、详情页等没有表格骨架的场景） */
export function ErrorResult({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Result
      status="error"
      title="数据加载失败"
      subTitle={error}
      extra={
        <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
          重新加载
        </Button>
      }
      style={{ padding: '28px 0' }}
    />
  );
}

/** 表格空态，支持区分「暂无数据」与「没有搜索结果」 */
export function TableEmpty({
  keywordApplied,
  emptyText = '暂无数据',
  searchText = '没有匹配的记录，试试更换关键词',
}: {
  keywordApplied?: boolean;
  emptyText?: string;
  searchText?: string;
}) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keywordApplied ? searchText : emptyText} />;
}
