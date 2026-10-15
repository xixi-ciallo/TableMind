import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Divider,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Upload,
  message,
} from 'antd';
import type { UploadProps } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FilePdfOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  buildRuleDocs,
  deleteRuleBook,
  fetchRuleBooks,
  updateRuleBook,
  uploadRuleBook,
} from '../adminApi';
import type { AdminRuleBook } from '../adminTypes';

const MAX_SIZE_MB = 20;

/** 规则书翻阅：PDF 内嵌预览，图片按页翻 */
function RuleBookViewer({ book, onClose }: { book: AdminRuleBook; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const pages = book.pages ?? [];
  const isPdf = book.file_type === 'pdf';

  return (
    <Modal
      open
      title={`${book.title}（${book.page_count ?? '?'} 页）`}
      onCancel={onClose}
      footer={null}
      width={900}
      destroyOnHidden
    >
      {isPdf ? (
        <iframe
          src={book.url}
          title={book.title}
          style={{ width: '100%', height: '70vh', border: '1px solid var(--tm-border)', borderRadius: 8 }}
        />
      ) : pages.length === 0 ? (
        <Empty description="没有可翻阅的页面" />
      ) : (
        <div>
          <div style={{ textAlign: 'center', background: '#fafbfc', padding: 8, borderRadius: 8 }}>
            <img
              src={`${book.url}/${pages[page]}`}
              alt={`第 ${page + 1} 页`}
              style={{ maxWidth: '100%', maxHeight: '62vh', objectFit: 'contain' }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              marginTop: 10,
            }}
          >
            <Button
              size="small"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              上一页
            </Button>
            <span style={{ fontSize: 13, color: 'var(--tm-text-secondary)' }}>
              {page + 1} / {pages.length}
            </span>
            <Button
              size="small"
              disabled={page >= pages.length - 1}
              onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * 桌游编辑弹窗内的规则书面板。
 *
 * 只管理「规则书」（原始文件，PDF / 逐页图片）——保留排版插图，可翻阅、
 * 可改名、可删除；点「生成规则文档」把它切成切片并向量化供 AI 检索。
 *
 * 规则文档（切片）的逐条编辑已收敛到独立的「规则文档」管理页，这里不再重复展示。
 */
export default function GameRuleBookPanel({
  gameId,
  onChanged,
}: {
  gameId: number;
  gameName: string;
  /** 规则书数量变化时通知外层刷新列表 */
  onChanged?: () => void;
}) {
  const [books, setBooks] = useState<AdminRuleBook[] | null>(null);
  const [booksLoading, setBooksLoading] = useState(false);
  const [uploadingBook, setUploadingBook] = useState(false);
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [viewer, setViewer] = useState<AdminRuleBook | null>(null);
  const [editingBook, setEditingBook] = useState<AdminRuleBook | null>(null);
  const [bookTitle, setBookTitle] = useState('');

  const loadBooks = useCallback(async () => {
    setBooksLoading(true);
    try {
      setBooks(await fetchRuleBooks(gameId));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '规则书加载失败');
      setBooks([]);
    } finally {
      setBooksLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const bookBeforeUpload: UploadProps['beforeUpload'] = async (file) => {
    if (!(file instanceof File)) return Upload.LIST_IGNORE;
    if (file.size / 1024 / 1024 > MAX_SIZE_MB) {
      message.error(`${file.name} 超过 ${MAX_SIZE_MB}MB`);
      return Upload.LIST_IGNORE;
    }
    setUploadingBook(true);
    try {
      await uploadRuleBook(gameId, file, { source: '管理员上传' });
      message.success(`《${file.name}》已登记为规则书`);
      await loadBooks();
      onChanged?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploadingBook(false);
    }
    return Upload.LIST_IGNORE;
  };

  const buildDocs = async (book: AdminRuleBook) => {
    setBuildingId(book.id);
    try {
      const r = await buildRuleDocs(book.id, 'replace');
      message.success(
        `已生成 ${r.added ?? 0} 条切片${r.vectorized ? '并完成向量化' : '（部分缺向量）'}`,
      );
      await loadBooks();
      onChanged?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '生成规则文档失败');
    } finally {
      setBuildingId(null);
    }
  };

  const removeBook = async (book: AdminRuleBook) => {
    try {
      const r = await deleteRuleBook(book.id);
      message.success(`已删除规则书${r.deleted_chunks ? `，含 ${r.deleted_chunks} 条切片` : ''}`);
      await loadBooks();
      onChanged?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const saveBookTitle = async () => {
    if (!editingBook) return;
    const t = bookTitle.trim();
    if (!t) {
      message.error('标题不能为空');
      return;
    }
    try {
      await updateRuleBook(editingBook.id, { title: t });
      message.success('已更新');
      setEditingBook(null);
      await loadBooks();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--tm-border)',
        borderRadius: 'var(--tm-radius-md)',
        padding: '12px 14px',
        background: '#fafbfc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Space size={6}>
          <FilePdfOutlined style={{ color: 'var(--tm-text-secondary)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)' }}>
            规则书（原始文件）
          </span>
        </Space>
        {booksLoading ? <Spin size="small" /> : <Tag>{books?.length ?? 0} 份</Tag>}
        <Button
          type="link"
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => void loadBooks()}
          style={{ paddingInline: 0, marginLeft: 'auto' }}
        >
          刷新
        </Button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', margin: '4px 0 8px' }}>
        保留排版与插图的完整说明书，供前台原样翻阅；点「生成规则文档」才会切成切片供 AI 检索。
      </div>

      {books && books.length > 0 ? (
        <div style={{ maxHeight: 240, overflow: 'auto', paddingRight: 4 }}>
          {books.map((b) => (
            <div
              key={b.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: '#fff',
                border: '1px solid var(--tm-border)',
                borderRadius: 'var(--tm-radius-sm)',
                padding: '7px 10px',
                marginBottom: 6,
              }}
            >
              <Tag color={b.file_type === 'pdf' ? 'volcano' : 'geekblue'} style={{ marginInlineEnd: 0 }}>
                {b.file_type === 'pdf' ? 'PDF' : '图片'}
              </Tag>
              <span
                className="tm-clamp-1"
                style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--tm-text-primary)' }}
              >
                {b.title}
              </span>
              <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', flexShrink: 0 }}>
                {b.page_count ? `${b.page_count} 页` : '页数未知'}
                {b.is_official ? '' : ' · 非官方'}
              </span>
              <Tag color={(b.chunk_count ?? 0) > 0 ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
                {b.chunk_count ?? 0} 片
              </Tag>
              <Space size={0}>
                <Tooltip title="翻阅原文件">
                  <Button
                    type="link"
                    size="small"
                    icon={<EyeOutlined />}
                    style={{ paddingInline: 4 }}
                    onClick={() => setViewer(b)}
                  />
                </Tooltip>
                <Tooltip title="改名">
                  <Button
                    type="link"
                    size="small"
                    icon={<EditOutlined />}
                    style={{ paddingInline: 4 }}
                    onClick={() => {
                      setEditingBook(b);
                      setBookTitle(b.title);
                    }}
                  />
                </Tooltip>
                <Tooltip title={(b.chunk_count ?? 0) > 0 ? '按当前文件重建切片（覆盖）' : '生成切片并向量化'}>
                  <Button
                    type="link"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    loading={buildingId === b.id}
                    style={{ paddingInline: 4 }}
                    onClick={() => void buildDocs(b)}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除这本规则书？"
                  description="文件与其派生的切片会一并删除"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void removeBook(b)}
                >
                  <Button
                    type="link"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    style={{ paddingInline: 4 }}
                  />
                </Popconfirm>
              </Space>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有规则书原文件"
          style={{ padding: '10px 0', margin: 0 }}
        />
      )}

      <Upload.Dragger
        accept={'.pdf,.jpg,.jpeg,.png,.webp'}
        showUploadList={false}
        beforeUpload={bookBeforeUpload}
        disabled={uploadingBook}
        style={{ padding: '10px 8px', background: '#fff', marginTop: 4 }}
      >
        <p className="ant-upload-text" style={{ fontSize: 13 }}>
          {uploadingBook ? '正在上传…' : '点击或拖拽上传规则书（PDF / 图片）'}
        </p>
      </Upload.Dragger>

      <Divider style={{ margin: '14px 0 4px' }} />
      <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
        规则文档（切片）的逐条查看与编辑，请前往「规则文档」管理页处理。
      </div>

      {viewer ? <RuleBookViewer book={viewer} onClose={() => setViewer(null)} /> : null}

      {/* 规则书改名 */}
      <Modal
        open={!!editingBook}
        title="修改规则书标题"
        okText="保存"
        cancelText="取消"
        width={480}
        onOk={saveBookTitle}
        onCancel={() => setEditingBook(null)}
        destroyOnHidden
      >
        <Input
          value={bookTitle}
          onChange={(e) => setBookTitle(e.target.value)}
          maxLength={200}
          placeholder="如：卡坦岛 官方中文规则书"
        />
      </Modal>
    </div>
  );
}
