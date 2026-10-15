import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, InputNumber, Modal, Select, Spin, message } from 'antd';
import {
  CaretDownOutlined,
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  FontSizeOutlined,
  HolderOutlined,
  ImportOutlined,
  LineChartOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  PictureOutlined,
  PlaySquareOutlined,
  PlusOutlined,
  RightOutlined,
  SendOutlined,
  SmileOutlined,
  SwapOutlined,
  TableOutlined,
  TagOutlined,
  UnorderedListOutlined,
  VideoCameraOutlined,
  FileTextOutlined,
  SnippetsOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { pageContainerStyle } from '../../shared/theme';
import { useIsMobile } from '../../shared/useIsMobile';
import client from '../../shared/api/client';
import { useAuthStore } from '../../stores/auth';
import {
  blocksFromText,
  newBlock,
  serializeBlocks,
  stripMediaTokens,
  type EditorBlock,
  type EditorBlockType,
  type MediaItem,
} from '../../shared/postUtils';
import PostBlocksView from '../components/PostBlocksView';

interface GameOption {
  id: number;
  name: string;
  cover_image: string | null;
}

interface PollDraft {
  question: string;
  options: string[];
  multi: boolean;
  durationDays: number;
}

const MAX_HEADER_IMAGES = 18;
const MAX_INLINE_MEDIA = 9;

type PaletteType = 'cmd' | 'sub' | 'inline';
interface PaletteItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  type: PaletteType;
  sub?: 'heading' | 'list';
  inline?: 'emoji' | 'topic' | 'link';
}

/** + 菜单主列表：标题 / 列表 各自合成一个按钮，点击后再展开子选项 */
const PALETTE: PaletteItem[] = [
  { key: 'image', label: '图片', icon: <PictureOutlined />, type: 'cmd' },
  { key: 'video', label: '视频', icon: <PlaySquareOutlined />, type: 'cmd' },
  { key: 'poll', label: '投票', icon: <LineChartOutlined />, type: 'cmd' },
  { key: 'heading', label: '标题', icon: <FontSizeOutlined />, type: 'sub', sub: 'heading' },
  { key: 'list', label: '列表', icon: <UnorderedListOutlined />, type: 'sub', sub: 'list' },
  { key: 'quote', label: '引用', icon: <FileTextOutlined />, type: 'cmd' },
  { key: 'code', label: '代码块', icon: <CodeOutlined />, type: 'cmd' },
  { key: 'divider', label: '分割线', icon: <MinusOutlined />, type: 'cmd' },
  { key: 'table', label: '表格', icon: <TableOutlined />, type: 'cmd' },
  { key: 'emoji', label: '表情', icon: <SmileOutlined />, type: 'inline', inline: 'emoji' },
  { key: 'topic', label: '# 话题', icon: <TagOutlined />, type: 'inline', inline: 'topic' },
  { key: 'link', label: '链接', icon: <LinkOutlined />, type: 'inline', inline: 'link' },
  { key: 'import', label: '导入文档', icon: <ImportOutlined />, type: 'cmd' },
];

const SUBMENUS: Record<'heading' | 'list', { key: string; label: string; icon: React.ReactNode }[]> = {
  heading: [
    { key: 'p', label: '正文', icon: <FontSizeOutlined /> },
    { key: 'h1', label: '标题 1', icon: <FontSizeOutlined /> },
    { key: 'h2', label: '标题 2', icon: <FontSizeOutlined /> },
    { key: 'h3', label: '标题 3', icon: <FontSizeOutlined /> },
  ],
  list: [
    { key: 'ul', label: '无序列表', icon: <UnorderedListOutlined /> },
    { key: 'ol', label: '有序列表', icon: <OrderedListOutlined /> },
  ],
};

/** 块类型中文名（块菜单标题 / 转换为列表） */
const BLOCK_LABELS: Record<EditorBlockType, string> = {
  p: '正文',
  h1: '标题 1',
  h2: '标题 2',
  h3: '标题 3',
  ul: '无序列表',
  ol: '有序列表',
  quote: '引用',
  code: '代码块',
  divider: '分割线',
  image: '图片',
  video: '视频',
  table: '表格',
  poll: '投票',
};

const TEXT_TYPES: EditorBlockType[] = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code'];

/** 块菜单「转换为」子列表（参照 Notion Turn into） */
const CONVERT_ITEMS = [
  { key: 'p', label: '正文', icon: <FontSizeOutlined /> },
  { key: 'h1', label: '标题 1', icon: <FontSizeOutlined /> },
  { key: 'h2', label: '标题 2', icon: <FontSizeOutlined /> },
  { key: 'h3', label: '标题 3', icon: <FontSizeOutlined /> },
  { key: 'ul', label: '无序列表', icon: <UnorderedListOutlined /> },
  { key: 'ol', label: '有序列表', icon: <OrderedListOutlined /> },
  { key: 'quote', label: '引用', icon: <FileTextOutlined /> },
  { key: 'code', label: '代码块', icon: <CodeOutlined /> },
];

const EMOJIS = [
  '😀', '😄', '😁', '😆', '😅', '🤣', '😊', '😍', '😘', '🤔',
  '😎', '🥳', '😭', '😡', '👍', '👎', '👏', '🙏', '💪', '🤝',
  '🔥', '⭐', '✨', '💡', '❤️', '💔', '🎉', '🎮', '🎲', '🃏',
  '♟️', '🧩', '📚', '📝', '✅', '❌', '⚡', '🌟', '🍻', '☕',
  '🎯', '💯', '🚀', '🌈', '🐱', '🐶', '💰', '🏆', '🥇', '😴',
  '🤩', '😏', '🙄', '😇',
];

/**
 * 发布页：参照 TapTap 动态编辑器 ——
 * 头图区（≤18 图或 1 视频互斥，首图为封面）+ 大标题 + 块式正文编辑器
 * （每块带「+ 插入菜单」与「⠿ 按住拖动」，支持 / 指令、投票、表情/话题/链接）+ 右侧实时预览。
 */
export default function PostComposePage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { token, user } = useAuthStore();
  const isLoggedIn = Boolean(token);

  const [title, setTitle] = useState('');
  const [gameId, setGameId] = useState<number | undefined>(undefined);
  const [games, setGames] = useState<GameOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  /* 头图区：图片与视频互斥 */
  const [headerImages, setHeaderImages] = useState<MediaItem[]>([]);
  const [headerVideo, setHeaderVideo] = useState<MediaItem | null>(null);

  /* 块式正文 */
  const [blocks, setBlocks] = useState<EditorBlock[]>([newBlock('p')]);
  const [pollDraft, setPollDraft] = useState<PollDraft | null>(null);

  /* 交互态 */
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [paletteSub, setPaletteSub] = useState<'heading' | 'list' | null>(null);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [inlinePop, setInlinePop] = useState<'emoji' | 'topic' | 'link' | null>(null);
  /* ⠿ 手柄的块菜单（点击弹出：转换为 / 复制节点 / 复制到剪贴板 / 删除） */
  const [handleFor, setHandleFor] = useState<string | null>(null);
  const [handleSub, setHandleSub] = useState<'convert' | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [pollModalOpen, setPollModalOpen] = useState(false);
  const [pollForm, setPollForm] = useState<PollDraft>({
    question: '',
    options: ['', ''],
    multi: false,
    durationDays: 7,
  });
  const [pollEditId, setPollEditId] = useState<string | null>(null); // 正在编辑的投票块
  const [dragging, setDragging] = useState(false); // 拖文件悬停
  const [topicDraft, setTopicDraft] = useState('');
  const [linkTextDraft, setLinkTextDraft] = useState('');
  const [linkUrlDraft, setLinkUrlDraft] = useState('');

  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const headerImgInputRef = useRef<HTMLInputElement | null>(null);
  const headerVideoInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<{ blockId: string | null; kind: 'image' | 'video' }>({
    blockId: null,
    kind: 'image',
  });
  /** 各文本块 textarea 的引用，用于跨块聚焦与光标定位 */
  const focusMap = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  /** 最近一次光标位置，用于表情/话题/链接插入 */
  const caretRef = useRef<{ id: string; start: number; end: number } | null>(null);
  /** 需要自动聚焦的块（回车新建 / 退格合并后） */
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    client
      .get('/games', { params: { page_size: 100 } })
      .then(({ data }) => {
        const rows = Array.isArray(data) ? data : data?.rows ?? data?.items ?? [];
        setGames(
          rows.map((g: { id: number; name: string; cover_image?: string | null }) => ({
            id: g.id,
            name: g.name,
            cover_image: g.cover_image ?? null,
          })),
        );
      })
      .catch(() => {});
  }, []);

  /* 回车新建 / 退格合并后自动聚焦目标块 */
  useEffect(() => {
    if (!pendingFocus.current) return;
    const id = pendingFocus.current;
    pendingFocus.current = null;
    requestAnimationFrame(() => {
      const el = focusMap.current.get(id);
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }, [blocks]);

  /* 点击空白处 / Esc 关闭 + 菜单与手柄菜单 */
  useEffect(() => {
    if (!paletteFor && !handleFor) return;
    const onDown = (e: MouseEvent) => {
      const id = paletteFor ?? handleFor;
      const scope = id ? document.querySelector(`[data-palette-scope="${id}"]`) : null;
      if (scope && !scope.contains(e.target as Node)) closePalette();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [paletteFor, handleFor]);

  useEffect(() => {
    if (!paletteFor && !inlinePop && !handleFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteFor, inlinePop, handleFor]);

  const closePalette = () => {
    setPaletteFor(null);
    setPaletteSub(null);
    setPaletteFilter('');
    setInlinePop(null);
    setHandleFor(null);
    setHandleSub(null);
  };

  /* ⠿ 手柄：点击弹块菜单（按住仍可拖动排序） */
  const openHandle = (id: string) => {
    if (handleFor === id) {
      closePalette();
      return;
    }
    setPaletteFor(null);
    setPaletteSub(null);
    setPaletteFilter('');
    setInlinePop(null);
    setHandleFor(id);
    setHandleSub(null);
  };

  /* 复制节点：在下方插入一个内容相同的副本 */
  const duplicateBlock = (id: string) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    const copy: EditorBlock = { ...b, id: newBlock(b.type).id };
    setBlocks((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    closePalette();
    message.success('已复制节点');
  };

  /* 复制到剪贴板：该块的 Markdown 文本 */
  const copyBlockToClipboard = async (b: EditorBlock) => {
    const text = serializeBlocks([b]);
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.warning('复制失败，请手动选择复制');
    }
    closePalette();
  };

  /* Ctrl/Cmd + D：复制当前聚焦的块 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        const id = caretRef.current?.id;
        if (id && blocks.some((x) => x.id === id)) {
          e.preventDefault();
          duplicateBlock(id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selectedGame = useMemo(() => games.find((g) => g.id === gameId) ?? null, [games, gameId]);
  const content = useMemo(() => serializeBlocks(blocks), [blocks]);
  const plainChars = content.replace(/\s+/g, '').length;
  const inlineCount = blocks.filter((b) => b.type === 'image' || b.type === 'video').length;
  const canSubmit =
    title.trim().length > 0 &&
    stripMediaTokens(content).replace(/\s+/g, '').length + (headerImages.length || headerVideo ? 1 : 0) > 0 &&
    !submitting &&
    !uploading;

  /* ── 块操作 ── */
  const updateBlock = (id: string, patch: Partial<EditorBlock>) =>
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const insertBlockAfter = (anchorId: string | null, block: EditorBlock) =>
    setBlocks((prev) => {
      const idx = anchorId ? prev.findIndex((b) => b.id === anchorId) : prev.length - 1;
      const at = anchorId ? idx + 1 : prev.length;
      return [...prev.slice(0, at), block, ...prev.slice(at)];
    });

  const removeBlock = (id: string) => {
    const b = blocks.find((x) => x.id === id);
    if (b?.mediaId) void client.delete(`/posts/media/${b.mediaId}`).catch(() => {});
    if (b?.type === 'poll') setPollDraft(null);
    setBlocks((prev) => {
      const next = prev.filter((x) => x.id !== id);
      return next.length ? next : [newBlock('p')];
    });
  };

  const moveBlock = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setBlocks((prev) => {
      const from = prev.findIndex((b) => b.id === fromId);
      const to = prev.findIndex((b) => b.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const lastTextBlockId = (): string | null => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const t = blocks[i].type;
      if (['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code'].includes(t)) return blocks[i].id;
    }
    return null;
  };

  /* 在光标处插入文本（表情 / 话题 / 链接），并恢复焦点与光标 */
  const insertAtCaret = (text: string, targetId?: string) => {
    const id = targetId ?? caretRef.current?.id ?? lastTextBlockId();
    if (!id) {
      const nb = newBlock('p', { text });
      setBlocks((prev) => [...prev, nb]);
      pendingFocus.current = nb.id;
      closePalette();
      return;
    }
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    const base = caretRef.current && caretRef.current.id === id ? caretRef.current.start : (b.text ?? '').length;
    const cur = b.text ?? '';
    const np = base + text.length;
    updateBlock(id, { text: cur.slice(0, base) + text + cur.slice(base) });
    caretRef.current = { id, start: np, end: np };
    requestAnimationFrame(() => {
      const el = focusMap.current.get(id);
      if (el) {
        el.focus();
        el.setSelectionRange(np, np);
      }
    });
    closePalette();
  };

  const trackCaret = (id: string, el: HTMLTextAreaElement) => {
    caretRef.current = { id, start: el.selectionStart, end: el.selectionEnd };
  };

  /* 回车：正文 / 标题块拆分为「上一行 + 新段落」；列表 / 引用 / 代码块内部换行 */
  const handleEnterSplit = (id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    const pos = e.currentTarget.selectionStart ?? (b.text ?? '').length;
    const cur = b.text ?? '';
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    closePalette();
    setBlocks((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], text: before };
      const nb = newBlock('p', { text: after });
      next.splice(idx + 1, 0, nb);
      pendingFocus.current = nb.id;
      return next;
    });
  };

  /* 退格：空段落与上一块合并，并聚焦上一块末尾 */
  const handleBackspaceMerge = (id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const idx = blocks.findIndex((x) => x.id === id);
    if (idx <= 0) return;
    e.preventDefault();
    closePalette();
    setBlocks((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      if (i <= 0) return prev;
      const next = [...prev];
      next.splice(i, 1);
      pendingFocus.current = prev[i - 1].id;
      return next;
    });
  };

  const onTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, b: EditorBlock) => {
    if (e.key === 'Enter') {
      if (['p', 'h1', 'h2', 'h3'].includes(b.type) && !e.shiftKey) {
        e.preventDefault();
        handleEnterSplit(b.id, e);
      }
    } else if (e.key === 'Backspace') {
      if (b.type === 'p' && (b.text ?? '').length === 0) handleBackspaceMerge(b.id, e);
    }
  };

  /* ── 上传 ── */
  const upload = async (files: File[], slot: 'header' | 'inline'): Promise<MediaItem[]> => {
    if (!files.length) return [];
    setUploading(true);
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('slot', slot);
    try {
      const { data } = await client.post<MediaItem[]>('/posts/media', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data;
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof msg === 'string' ? msg : '上传失败，请重试');
      return [];
    } finally {
      setUploading(false);
    }
  };

  const addHeaderImages = async (files: File[]) => {
    if (headerVideo) {
      message.warning('已上传头图视频，二者只能选一种');
      return;
    }
    if (headerImages.length + files.length > MAX_HEADER_IMAGES) {
      message.warning(`头图最多 ${MAX_HEADER_IMAGES} 张`);
      return;
    }
    const items = await upload(files, 'header');
    if (items.length) setHeaderImages((prev) => [...prev, ...items]);
  };

  const addHeaderVideo = async (files: File[]) => {
    if (headerImages.length || headerVideo) {
      message.warning('头图与视频只能选择一种，请先移除已有的头图');
      return;
    }
    const items = await upload(files.slice(0, 1), 'header');
    if (items.length) setHeaderVideo(items[0]);
  };

  const removeHeaderImage = async (m: MediaItem) => {
    setHeaderImages((prev) => prev.filter((x) => x.id !== m.id));
    await client.delete(`/posts/media/${m.id}`).catch(() => {});
  };

  const removeHeaderVideo = async () => {
    if (headerVideo) await client.delete(`/posts/media/${headerVideo.id}`).catch(() => {});
    setHeaderVideo(null);
  };

  const addInlineMedia = async (files: File[], kind: 'image' | 'video', blockId: string | null) => {
    if (inlineCount + files.length > MAX_INLINE_MEDIA) {
      message.warning(`正文最多插入 ${MAX_INLINE_MEDIA} 个附件`);
      return;
    }
    const items = await upload(files, 'inline');
    let anchor = blockId;
    for (const m of items) {
      const blk = newBlock(kind === 'image' ? 'image' : 'video', { url: m.url, mediaId: m.id });
      insertBlockAfter(anchor, blk);
      anchor = blk.id;
    }
    if (items.length) message.success(`已插入 ${items.length} 个附件`);
  };

  /* ── 命令面板 ── */
  const openPalette = (id: string) => {
    if (paletteFor === id) {
      closePalette();
      return;
    }
    setHandleFor(null);
    setHandleSub(null);
    setPaletteFor(id);
    setPaletteSub(null);
    setPaletteFilter('');
    setInlinePop(null);
  };

  const runCommand = async (key: string, blockId: string) => {
    // 「/」指令模式下，选中命令即清掉前缀文本
    if (paletteFilter) {
      const blk = blocks.find((x) => x.id === blockId);
      if (blk && blk.text) updateBlock(blockId, { text: '' });
    }
    closePalette();
    const b = blocks.find((x) => x.id === blockId);
    if (['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code', 'divider', 'table'].includes(key)) {
      if (b) updateBlock(blockId, { type: key as EditorBlockType, text: b.text });
      return;
    }
    if (key === 'image' || key === 'video') {
      uploadTarget.current = { blockId, kind: key as 'image' | 'video' };
      (key === 'image' ? imgInputRef : videoInputRef).current?.click();
      return;
    }
    if (key === 'poll') {
      if (pollDraft) {
        message.info('一篇帖子只能有一个投票，可点击已有投票块进行编辑');
        return;
      }
      uploadTarget.current = { blockId, kind: 'image' };
      setPollEditId(null);
      setPollForm({ question: '', options: ['', ''], multi: false, durationDays: 7 });
      setPollModalOpen(true);
      return;
    }
    if (key === 'import') {
      uploadTarget.current = { blockId, kind: 'image' };
      importInputRef.current?.click();
    }
  };

  /* 「/」指令进入子菜单 / 行内面板前，清掉前缀文本与光标 */
  const clearSlashText = (id: string) => {
    const blk = blocks.find((x) => x.id === id);
    if (blk && blk.text) {
      updateBlock(id, { text: '' });
      caretRef.current = { id, start: 0, end: 0 };
    }
  };

  const onPaletteItem = (item: PaletteItem, id: string) => {
    if (item.type === 'sub') {
      if (paletteFilter) clearSlashText(id);
      setPaletteSub(item.sub as 'heading' | 'list');
      setPaletteFilter('');
      return;
    }
    if (item.type === 'inline') {
      if (paletteFilter) clearSlashText(id);
      setInlinePop(item.inline as 'emoji' | 'topic' | 'link');
      return;
    }
    void runCommand(item.key, id);
  };

  const importDoc = async (file: File) => {
    const text = await file.text();
    const imported = blocksFromText(text).filter((b) => b.type !== 'poll');
    if (!imported.length) {
      message.warning('没有解析到可导入的内容');
      return;
    }
    setBlocks((prev) => {
      const anchor = uploadTarget.current.blockId;
      const idx = anchor ? prev.findIndex((b) => b.id === anchor) : prev.length - 1;
      const at = anchor ? idx + 1 : prev.length;
      return [...prev.slice(0, at), ...imported, ...prev.slice(at)];
    });
    message.success(`已导入 ${imported.length} 个内容块`);
  };

  /* ── 投票弹窗 ── */
  const confirmPoll = () => {
    const options = pollForm.options.map((o) => o.trim());
    if (!pollForm.question.trim()) {
      message.warning('请填写投票标题');
      return;
    }
    const filled = options.filter(Boolean);
    if (filled.length < 2) {
      message.warning('至少需要 2 个非空选项');
      return;
    }
    const draft: PollDraft = { ...pollForm, options: filled };
    setPollDraft(draft);
    if (!pollEditId) {
      insertBlockAfter(uploadTarget.current.blockId, newBlock('poll', { pollId: -1 }));
    }
    setPollModalOpen(false);
  };

  const editPoll = (blockId: string) => {
    if (!pollDraft) return;
    setPollEditId(blockId);
    setPollForm({
      question: pollDraft.question,
      options: [...pollDraft.options],
      multi: pollDraft.multi,
      durationDays: pollDraft.durationDays,
    });
    setPollModalOpen(true);
  };

  /* ── 提交 ── */
  const submit = async () => {
    if (!canSubmit) {
      message.warning('标题和内容都要填写');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await client.post<{ id: number }>('/posts', {
        title: title.trim(),
        content,
        game_id: gameId ?? null,
        media_ids: blocks.filter((b) => b.mediaId).map((b) => b.mediaId as number),
        header_media_ids: [...headerImages.map((m) => m.id), ...(headerVideo ? [headerVideo.id] : [])],
        poll: pollDraft
          ? {
              question: pollDraft.question,
              options: pollDraft.options,
              multi: pollDraft.multi,
              duration_days: pollDraft.durationDays,
            }
          : null,
      });
      message.success('帖子已发布');
      navigate(`/community/${data.id}`);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof msg === 'string' ? msg : '发布失败，请重试');
      setSubmitting(false);
    }
  };

  /* ── 文本块自适应高度 ── */
  const autoGrow = (el: HTMLTextAreaElement, min: number) => {
    el.style.height = 'auto';
    el.style.height = `${Math.max(min, el.scrollHeight)}px`;
  };

  /* ── 文本类块的统一渲染（内联，避免组件重挂载导致光标丢失） ── */
  const renderTextBlock = (b: EditorBlock) => {
    const isHeading = b.type === 'h1' || b.type === 'h2' || b.type === 'h3';
    const isList = b.type === 'ul' || b.type === 'ol';
    const isCode = b.type === 'code';
    const isQuote = b.type === 'quote';
    const size = b.type === 'h1' ? 23 : b.type === 'h2' ? 20 : b.type === 'h3' ? 18 : 16;
    const minH = b.type === 'p' || isHeading ? 30 : 60;
    const placeholder =
      b.type === 'p'
        ? blocks.length === 1 && !b.text
          ? '输入“/”可添加图片、视频、投票…… 也可以直接在这里写正文'
          : undefined
        : b.type === 'h1'
          ? '标题 1…'
          : b.type === 'h2'
            ? '标题 2…'
            : b.type === 'h3'
              ? '标题 3…'
              : isList
                ? b.type === 'ul'
                  ? '列表项，每行一条'
                  : '有序列表项，每行一条（发布后自动编号）'
                : isQuote
                  ? '引用内容…'
                  : '代码块…';

    const base: React.CSSProperties = {
      width: '100%',
      border: 'none',
      outline: 'none',
      resize: 'none',
      fontFamily: 'inherit',
      background: 'transparent',
      color: 'var(--tm-text-primary)',
      padding: isQuote ? '12px 16px' : isCode ? '12px 14px' : '10px 0',
      fontSize: isCode ? 13 : size,
      lineHeight: isCode ? 1.7 : 2,
      fontWeight: isHeading ? 800 : 400,
    };
    if (isQuote) {
      base.borderLeft = '3px solid var(--tm-action)';
      base.background = 'var(--tm-tint)';
      base.borderRadius = '0 10px 10px 0';
      base.color = 'var(--tm-text-secondary)';
      base.fontSize = 14.5;
    }
    if (isCode) {
      base.border = '1px solid var(--tm-border)';
      base.borderRadius = 10;
      base.color = '#24292f';
      base.fontFamily = 'SFMono-Regular, Consolas, monospace';
    }
    if (isList) base.padding = '10px 0 10px 4px';

    return (
      <textarea
        ref={(el) => {
          if (el) {
            focusMap.current.set(b.id, el);
            autoGrow(el, minH);
          }
        }}
        value={b.text ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const val = e.target.value;
          updateBlock(b.id, { text: val });
          autoGrow(e.currentTarget, minH);
          if (b.type === 'p') {
            if (val.startsWith('/')) {
              setPaletteFor(b.id);
              setPaletteFilter(val.slice(1));
            } else if (paletteFor === b.id) {
              closePalette();
            }
          }
        }}
        onInput={(e) => autoGrow(e.currentTarget, minH)}
        onSelect={(e) => trackCaret(b.id, e.currentTarget)}
        onKeyUp={(e) => trackCaret(b.id, e.currentTarget)}
        onClick={(e) => trackCaret(b.id, e.currentTarget)}
        onFocus={(e) => trackCaret(b.id, e.currentTarget)}
        onKeyDown={(e) => onTextKeyDown(e, b)}
        rows={1}
        style={base}
      />
    );
  };

  /* ── 行内插入面板（表情 / 话题 / 链接） ── */
  const renderInlinePop = (kind: 'emoji' | 'topic' | 'link', blockId: string) => {
    if (kind === 'emoji') {
      return (
        <div>
          <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', padding: '2px 8px 6px' }}>选择表情</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, maxHeight: 208, overflowY: 'auto' }}>
            {EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => insertAtCaret(em, blockId)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 7,
                  fontSize: 18,
                  lineHeight: 1,
                  padding: '5px 0',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--tm-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {em}
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (kind === 'topic') {
      return (
        <div style={{ padding: '4px 2px' }}>
          <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginBottom: 6 }}>
            输入话题，发布后显示为 <span style={{ color: 'var(--tm-action)', fontWeight: 700 }}>#话题#</span>
          </div>
          <input
            value={topicDraft}
            autoFocus
            placeholder="如 桌游推荐"
            onChange={(e) => setTopicDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && topicDraft.trim()) {
                insertAtCaret(`#${topicDraft.trim()}#`, blockId);
                setTopicDraft('');
              }
            }}
            style={popInputStyle}
          />
          <button
            type="button"
            className="tm-press"
            disabled={!topicDraft.trim()}
            onClick={() => {
              insertAtCaret(`#${topicDraft.trim()}#`, blockId);
              setTopicDraft('');
            }}
            style={popConfirmStyle}
          >
            插入话题
          </button>
        </div>
      );
    }
    return (
      <div style={{ padding: '4px 2px' }}>
        <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginBottom: 6 }}>添加链接</div>
        <input
          value={linkTextDraft}
          autoFocus
          placeholder="显示文字（可选）"
          onChange={(e) => setLinkTextDraft(e.target.value)}
          style={popInputStyle}
        />
        <input
          value={linkUrlDraft}
          placeholder="https://…"
          onChange={(e) => setLinkUrlDraft(e.target.value)}
          style={{ ...popInputStyle, marginTop: 6 }}
        />
        <button
          type="button"
          className="tm-press"
          disabled={!linkUrlDraft.trim()}
          onClick={() => {
            const url = linkUrlDraft.trim();
            const txt = linkTextDraft.trim();
            const token = txt ? `[${txt}](${url})` : url;
            insertAtCaret(token, blockId);
            setLinkTextDraft('');
            setLinkUrlDraft('');
          }}
          style={popConfirmStyle}
        >
          插入链接
        </button>
      </div>
    );
  };

  const popInputStyle: React.CSSProperties = {
    width: '100%',
    border: '1px solid var(--tm-border)',
    borderRadius: 9,
    padding: '9px 11px',
    fontSize: 13.5,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  };
  const popConfirmStyle: React.CSSProperties = {
    marginTop: 8,
    width: '100%',
    border: 'none',
    borderRadius: 9,
    padding: '9px 0',
    fontSize: 13.5,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: 'var(--tm-action)',
    color: '#fff',
  };

  if (!isLoggedIn) {
    return (
      <div style={{ ...pageContainerStyle, textAlign: 'center', padding: '80px 0' }}>
        <div style={{ fontSize: 16, color: 'var(--tm-text-secondary)', marginBottom: 16 }}>发布帖子前请先登录</div>
        <Button type="primary" onClick={() => navigate('/login')}>
          去登录
        </Button>
      </div>
    );
  }

  /* 过滤后的命令列表（“/”指令） */
  const paletteItems = PALETTE.filter((c) => (paletteFilter ? c.label.includes(paletteFilter) : true));

  return (
    <div
      className="tm-page-enter"
      style={{ ...pageContainerStyle, padding: isMobile ? '8px 16px 96px' : undefined }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addHeaderImages(Array.from(e.dataTransfer.files));
      }}
    >
      {/* 顶栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => navigate('/community')}
          className="tm-press"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--tm-text-secondary)',
            fontSize: 13.5,
            padding: '4px 0',
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ← 返回社区
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}>
            {plainChars} 字 · 头图 {headerImages.length || (headerVideo ? 1 : 0)}/18 · 正文附件 {inlineCount}/9
          </span>
          <Button type="primary" icon={<SendOutlined />} loading={submitting} disabled={!canSubmit} onClick={submit}>
            发布
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* 左侧编辑器 */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: '#fff',
            border: `1.5px solid ${dragging ? 'var(--tm-action)' : 'var(--tm-border)'}`,
            borderRadius: 14,
            padding: isMobile ? '16px 14px' : '22px 30px',
            transition: 'border-color .18s var(--tm-ease-out)',
          }}
        >
          {/* 头图区：添加头图 / 添加视频（互斥） */}
          {headerImages.length === 0 && !headerVideo && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14 }}>
              <button
                type="button"
                className="tm-press tm-add-btn"
                onClick={() => headerImgInputRef.current?.click()}
                disabled={uploading}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--tm-text-secondary)',
                  fontFamily: 'inherit',
                  padding: '4px 8px',
                  borderRadius: 9,
                }}
              >
                <span
                  className="tm-add-ico"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: 'var(--tm-tint)',
                    color: 'var(--tm-action)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                  }}
                >
                  <PictureOutlined />
                </span>
                <span className="tm-add-txt">添加头图 (0/{MAX_HEADER_IMAGES})</span>
              </button>
              <button
                type="button"
                className="tm-press tm-add-btn"
                onClick={() => headerVideoInputRef.current?.click()}
                disabled={uploading}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--tm-text-tertiary)',
                  fontFamily: 'inherit',
                  padding: '4px 8px',
                  borderRadius: 9,
                }}
              >
                <span
                  className="tm-add-ico"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: '#f0f1f3',
                    color: 'var(--tm-text-tertiary)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                  }}
                >
                  <VideoCameraOutlined />
                </span>
                <span className="tm-add-txt">添加视频</span>
              </button>
              {uploading && <Spin size="small" />}
            </div>
          )}

          {/* 头图缩略图条：第一张为封面，点击放大，可删除 */}
          {headerImages.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {headerImages.map((m, i) => (
                <div
                  key={m.id}
                  style={{
                    position: 'relative',
                    width: 92,
                    height: 92,
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: i === 0 ? '2px solid var(--tm-action)' : '1px solid var(--tm-border)',
                    background: '#f2f3f4',
                  }}
                >
                  <img
                    src={m.url}
                    alt=""
                    onClick={() => setViewer(m.url)}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }}
                  />
                  {i === 0 && (
                    <span
                      style={{
                        position: 'absolute',
                        left: 0,
                        bottom: 0,
                        right: 0,
                        background: 'linear-gradient(transparent, rgba(0,0,0,.55))',
                        color: '#fff',
                        fontSize: 10.5,
                        fontWeight: 700,
                        textAlign: 'center',
                        padding: '6px 0 2px',
                      }}
                    >
                      封面
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeHeaderImage(m)}
                    title="移除"
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(0,0,0,.55)',
                      color: '#fff',
                      fontSize: 10,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    <CloseOutlined />
                  </button>
                </div>
              ))}
              {headerImages.length < MAX_HEADER_IMAGES && (
                <button
                  type="button"
                  className="tm-press"
                  onClick={() => headerImgInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    width: 92,
                    height: 92,
                    borderRadius: 10,
                    border: '1.5px dashed var(--tm-border-strong)',
                    background: '#fafafa',
                    color: 'var(--tm-text-tertiary)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                    fontFamily: 'inherit',
                  }}
                >
                  <PlusOutlined style={{ fontSize: 18 }} />
                  <span style={{ fontSize: 11 }}>
                    {headerImages.length}/{MAX_HEADER_IMAGES}
                  </span>
                </button>
              )}
            </div>
          )}

          {/* 头图视频预览（与头图互斥） */}
          {headerVideo && (
            <div style={{ position: 'relative', marginBottom: 14 }}>
              <video
                src={`${headerVideo.url}#t=0.1`}
                controls
                preload="metadata"
                style={{ width: '100%', maxHeight: 260, borderRadius: 12, background: '#000' }}
              />
              <button
                type="button"
                onClick={() => void removeHeaderVideo()}
                title="移除视频"
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(0,0,0,.6)',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <CloseOutlined />
              </button>
            </div>
          )}

          <input
            placeholder="添加标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              fontSize: 22,
              fontWeight: 800,
              color: 'var(--tm-text-primary)',
              padding: '0 0 12px',
              borderBottom: '1px solid var(--tm-border)',
              fontFamily: 'inherit',
              background: 'transparent',
            }}
          />

          {/* 块式编辑器：中间预留更大的内容区 */}
          <div style={{ marginTop: 8, minHeight: 360 }}>
            {blocks.map((b) => (
              <div
                key={b.id}
                data-palette-scope={b.id}
                className="tm-blk-row"
                onDragOver={(e) => {
                  if (dragId && dragId !== b.id) {
                    e.preventDefault();
                    setDragOverId(b.id);
                  }
                }}
                onDrop={() => {
                  if (dragId) moveBlock(dragId, b.id);
                  setDragId(null);
                  setDragOverId(null);
                }}
                style={{
                  position: 'relative',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'flex-start',
                  borderRadius: 10,
                  opacity: dragId === b.id ? 0.45 : 1,
                  outline: dragOverId === b.id && dragId !== b.id ? '1.5px dashed var(--tm-action)' : 'none',
                  transition: 'opacity .15s',
                }}
              >
                {/* 左侧手柄区：+ 插入菜单 / ⠿ 拖动排序（悬停显形） */}
                <div style={{ position: 'relative', paddingTop: 12, flexShrink: 0, display: 'flex', gap: 2 }}>
                  <button
                    type="button"
                    title="点击打开菜单"
                    className={`tm-press tm-gutter-btn tm-plus-btn${paletteFor === b.id ? ' is-active' : ''}`}
                    onClick={() => openPalette(b.id)}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: 'none',
                      fontSize: 14,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    <PlusOutlined style={{ fontSize: 12 }} />
                  </button>
                  <div
                    title="点击打开块菜单，按住拖动排序"
                    className={`tm-gutter-btn tm-handle-btn${handleFor === b.id ? ' is-active' : ''}`}
                    draggable
                    onClick={() => openHandle(b.id)}
                    onDragStart={(e) => {
                      setDragId(b.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDragOverId(null);
                    }}
                    style={{
                      width: 22,
                      paddingTop: 1,
                      cursor: 'grab',
                      fontSize: 14,
                      userSelect: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <HolderOutlined />
                  </div>

                  {/* ⠿ 手柄的块菜单：转换为 / 复制节点 / 复制到剪贴板 / 删除 */}
                  {handleFor === b.id && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 32,
                        left: 22,
                        zIndex: 80,
                        width: 252,
                        background: '#fff',
                        borderRadius: 12,
                        border: '1px solid var(--tm-border)',
                        boxShadow: '0 14px 38px rgba(15,23,42,.18)',
                        padding: 6,
                        maxHeight: 380,
                        overflowY: 'auto',
                      }}
                    >
                      {handleSub === 'convert' ? (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tm-text-tertiary)', padding: '5px 10px 7px' }}>
                            转换为
                          </div>
                          <div className="tm-palette-list">
                            {CONVERT_ITEMS.map((it) => (
                              <button
                                key={it.key}
                                type="button"
                                className="tm-palette-item"
                                onClick={() => {
                                  setHandleFor(null);
                                  setHandleSub(null);
                                  void runCommand(it.key, b.id);
                                }}
                              >
                                <span className="tm-palette-ico">{it.icon}</span>
                                {it.label}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tm-text-tertiary)', padding: '5px 10px 7px' }}>
                            {BLOCK_LABELS[b.type]}
                          </div>
                          {TEXT_TYPES.includes(b.type) && (
                            <button type="button" className="tm-palette-item" onClick={() => setHandleSub('convert')}>
                              <span className="tm-palette-ico">
                                <SwapOutlined />
                              </span>
                              转换为
                              <RightOutlined style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--tm-text-tertiary)' }} />
                            </button>
                          )}
                          <div style={{ borderTop: '1px solid var(--tm-border)', margin: '4px 6px' }} />
                          <button type="button" className="tm-palette-item" onClick={() => duplicateBlock(b.id)}>
                            <span className="tm-palette-ico">
                              <CopyOutlined />
                            </span>
                            复制节点
                            <span className="tm-kbd">ModD</span>
                          </button>
                          <button type="button" className="tm-palette-item" onClick={() => void copyBlockToClipboard(b)}>
                            <span className="tm-palette-ico">
                              <SnippetsOutlined />
                            </span>
                            复制到剪贴板
                            <span className="tm-kbd">ModC</span>
                          </button>
                          <div style={{ borderTop: '1px solid var(--tm-border)', margin: '4px 6px' }} />
                          <button
                            type="button"
                            className="tm-palette-item"
                            onClick={() => {
                              removeBlock(b.id);
                              closePalette();
                            }}
                          >
                            <span className="tm-palette-ico">
                              <DeleteOutlined />
                            </span>
                            删除
                            <span className="tm-kbd">Backspace</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* + 菜单面板 */}
                  {paletteFor === b.id && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 32,
                        left: -4,
                        zIndex: 80,
                        width: 268,
                        background: '#fff',
                        borderRadius: 12,
                        border: '1px solid var(--tm-border)',
                        boxShadow: '0 14px 38px rgba(15,23,42,.18)',
                        padding: 6,
                        maxHeight: 340,
                        overflowY: 'auto',
                      }}
                    >
                      {inlinePop ? (
                        renderInlinePop(inlinePop, b.id)
                      ) : paletteSub ? (
                        <>
                          <button type="button" className="tm-palette-back" onClick={() => setPaletteSub(null)}>
                            ← 返回
                          </button>
                          <div className="tm-palette-list">
                            {SUBMENUS[paletteSub].map((it) => (
                              <button key={it.key} type="button" className="tm-palette-item" onClick={() => void runCommand(it.key, b.id)}>
                                <span className="tm-palette-ico">{it.icon}</span>
                                {it.label}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                          {paletteFilter && <div className="tm-palette-filter">/{paletteFilter}</div>}
                          <div className="tm-palette-list">
                            {paletteItems.length === 0 && <div className="tm-palette-empty">没有匹配的指令</div>}
                            {paletteItems.map((c) => (
                              <button key={c.key} type="button" className="tm-palette-item" onClick={() => onPaletteItem(c, b.id)}>
                                <span className="tm-palette-ico">{c.icon}</span>
                                {c.label}
                                {c.type === 'sub' && (
                                  <CaretDownOutlined
                                    style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--tm-text-tertiary)' }}
                                  />
                                )}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* 块内容 */}
                <div style={{ flex: 1, minWidth: 0, padding: '6px 0' }}>
                  {['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code'].includes(b.type) ? (
                    renderTextBlock(b)
                  ) : b.type === 'divider' ? (
                    <div style={{ padding: '14px 0' }}>
                      <hr style={{ border: 'none', borderTop: '1px solid var(--tm-border)' }} />
                    </div>
                  ) : b.type === 'image' ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <img
                        src={b.url}
                        alt=""
                        onClick={() => b.url && setViewer(b.url)}
                        style={{ maxHeight: 200, maxWidth: '100%', borderRadius: 10, cursor: 'pointer', background: '#f2f3f4' }}
                      />
                    </div>
                  ) : b.type === 'video' ? (
                    <video
                      src={`${b.url}#t=0.1`}
                      controls
                      preload="metadata"
                      style={{ width: '100%', maxHeight: 260, borderRadius: 10, background: '#000' }}
                    />
                  ) : b.type === 'table' ? (
                    <TableBlock b={b} updateBlock={updateBlock} />
                  ) : b.type === 'poll' ? (
                    <PollDraftBlock d={pollDraft} onEdit={() => b.id && editPoll(b.id)} />
                  ) : null}
                </div>

                {/* 删除块 */}
                {(b.type !== 'p' || b.text) && (
                  <button
                    type="button"
                    title="删除该块"
                    onClick={() => removeBlock(b.id)}
                    style={{
                      marginTop: 14,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--tm-text-tertiary)',
                      cursor: 'pointer',
                      fontSize: 12,
                      flexShrink: 0,
                      padding: 0,
                    }}
                  >
                    <CloseOutlined />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 底部工具栏：添加块 + 关联桌游 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderTop: '1px solid var(--tm-border)',
              paddingTop: 12,
              marginTop: 12,
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              className="tm-press"
              onClick={() => {
                const blk = newBlock('p');
                insertBlockAfter(null, blk);
                setPaletteFor(blk.id);
                setPaletteFilter('');
                setInlinePop(null);
                setPaletteSub(null);
              }}
              style={{
                border: '1px solid var(--tm-border)',
                background: '#fff',
                borderRadius: 999,
                padding: '6px 14px',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--tm-text-secondary)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <PlusOutlined /> 添加块
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: 'var(--tm-text-secondary)', flexShrink: 0 }}>关联桌游</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="搜索并关联一款桌游（可选）"
              value={gameId}
              onChange={(v) => setGameId(v)}
              options={games.map((g) => ({ value: g.id, label: g.name }))}
              style={{ minWidth: 220 }}
            />
          </div>

          {/* 隐藏文件输入 */}
          <input
            ref={headerImgInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              void addHeaderImages(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            ref={headerVideoInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            hidden
            onChange={(e) => {
              void addHeaderVideo(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            ref={imgInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              void addInlineMedia(Array.from(e.target.files ?? []), 'image', uploadTarget.current.blockId);
              e.target.value = '';
            }}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            hidden
            onChange={(e) => {
              void addInlineMedia(Array.from(e.target.files ?? []).slice(0, 1), 'video', uploadTarget.current.blockId);
              e.target.value = '';
            }}
          />
          <input
            ref={importInputRef}
            type="file"
            accept=".md,.markdown,.txt"
            hidden
            onChange={(e) => {
              const f = (e.target.files ?? [])[0];
              if (f) void importDoc(f);
              e.target.value = '';
            }}
          />
        </div>

        {/* 右侧实时预览 */}
        {!isMobile && (
          <aside style={{ width: 380, flexShrink: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: 'var(--tm-text-tertiary)',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              预览 · 发布后的样子
            </div>
            <div
              style={{
                background: '#fff',
                borderRadius: 14,
                border: '1px solid var(--tm-border)',
                overflow: 'hidden',
              }}
            >
              {/* 头图轮播：首图为封面 */}
              {headerImages.length > 0 ? (
                <div
                  style={{
                    display: 'flex',
                    overflowX: 'auto',
                    scrollSnapType: 'x mandatory',
                    scrollbarWidth: 'none',
                  }}
                >
                  {headerImages.map((m, i) => (
                    <div key={m.id} style={{ position: 'relative', flex: '0 0 100%', scrollSnapAlign: 'start' }}>
                      <img src={m.url} alt="" style={{ width: '100%', height: 200, objectFit: 'cover', display: 'block' }} />
                      <span
                        style={{
                          position: 'absolute',
                          left: 10,
                          bottom: 10,
                          background: 'rgba(0,0,0,.5)',
                          color: '#fff',
                          borderRadius: 999,
                          fontSize: 11,
                          padding: '2px 9px',
                        }}
                      >
                        {i + 1}/{headerImages.length}
                        {i === 0 ? ' · 封面' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ) : headerVideo ? (
                <video
                  src={`${headerVideo.url}#t=0.1`}
                  controls
                  preload="metadata"
                  style={{ width: '100%', height: 200, objectFit: 'cover', background: '#000', display: 'block' }}
                />
              ) : null}

              <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px 0' }}>
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'var(--tm-tint)',
                    color: 'var(--tm-action)',
                    fontWeight: 800,
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {(user?.username ?? '我').slice(0, 1)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{user?.username ?? '我'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--tm-text-tertiary)' }}>刚刚 · 预览</div>
                </div>
              </div>

              <div style={{ padding: '12px 16px 16px' }}>
                <h3
                  style={{
                    margin: 0,
                    fontSize: 16.5,
                    fontWeight: 800,
                    lineHeight: 1.45,
                    color: title.trim() ? 'var(--tm-text-primary)' : 'var(--tm-text-tertiary)',
                  }}
                >
                  {title.trim() || '帖子标题'}
                </h3>
                <div style={{ marginTop: 8 }}>
                  <PostBlocksView
                    content={content}
                    compact
                    previewPoll={
                      pollDraft
                        ? { question: pollDraft.question, options: pollDraft.options, multi: pollDraft.multi }
                        : null
                    }
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginTop: 10,
                    fontSize: 12.5,
                    color: 'var(--tm-text-tertiary)',
                    flexWrap: 'wrap',
                  }}
                >
                  {selectedGame && (
                    <span
                      style={{
                        background: 'var(--tm-tint)',
                        color: 'var(--tm-action)',
                        borderRadius: 999,
                        padding: '3px 10px',
                        fontWeight: 600,
                      }}
                    >
                      {selectedGame.name}
                    </span>
                  )}
                  <span>💬 0</span>
                  <span>👍 0</span>
                  <span>👁 0</span>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 10, lineHeight: 1.7 }}>
              每个内容块可用「+」插入图片、视频、投票、标题、列表、引用、代码块、分割线、表格、表情、#话题、链接，也可以导入
              Markdown 文档；点击 ⠿ 打开块菜单（转换为 / 复制节点 / 复制到剪贴板 / 删除），按住拖动可调整块顺序，Ctrl+D
              快速复制当前块。头图与视频只能二选一，第一张头图即封面。
            </div>
          </aside>
        )}
      </div>

      {/* 添加投票弹窗（对应 TapTap「添加投票」） */}
      <Modal
        open={pollModalOpen}
        title="添加投票"
        onCancel={() => setPollModalOpen(false)}
        footer={null}
        width={460}
        centered
      >
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>投票标题</div>
          <div style={{ position: 'relative' }}>
            <input
              value={pollForm.question}
              maxLength={16}
              placeholder="请输入标题"
              onChange={(e) => setPollForm((f) => ({ ...f, question: e.target.value }))}
              style={{
                width: '100%',
                border: '1px solid var(--tm-border)',
                borderRadius: 10,
                padding: '10px 52px 10px 12px',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <span style={{ position: 'absolute', right: 12, top: 10, fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
              {pollForm.question.length}/16
            </span>
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, margin: '16px 0 6px' }}>投票选项</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pollForm.options.map((o, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 800, fontSize: 14, width: 14, textAlign: 'center' }}>{i + 1}</span>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    value={o}
                    maxLength={18}
                    placeholder="请输入选项描述"
                    onChange={(e) =>
                      setPollForm((f) => ({
                        ...f,
                        options: f.options.map((x, j) => (j === i ? e.target.value : x)),
                      }))
                    }
                    style={{
                      width: '100%',
                      border: '1px solid var(--tm-border)',
                      borderRadius: 10,
                      padding: '9px 48px 9px 12px',
                      fontSize: 13.5,
                      fontFamily: 'inherit',
                      outline: 'none',
                    }}
                  />
                  <span style={{ position: 'absolute', right: 12, top: 9, fontSize: 11.5, color: 'var(--tm-text-tertiary)' }}>
                    {o.length}/18
                  </span>
                </div>
                {pollForm.options.length > 2 && (
                  <button
                    type="button"
                    onClick={() => setPollForm((f) => ({ ...f, options: f.options.filter((_, j) => j !== i) }))}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--tm-text-tertiary)',
                      cursor: 'pointer',
                      fontSize: 13,
                      padding: 0,
                    }}
                  >
                    <CloseOutlined />
                  </button>
                )}
              </div>
            ))}
          </div>
          {pollForm.options.length < 10 && (
            <button
              type="button"
              className="tm-press"
              onClick={() => setPollForm((f) => ({ ...f, options: [...f.options, ''] }))}
              style={{
                marginTop: 10,
                border: 'none',
                background: 'transparent',
                color: 'var(--tm-action)',
                fontWeight: 700,
                fontSize: 13.5,
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: 0,
              }}
            >
              <PlusOutlined /> 添加选项（{pollForm.options.length}/10）
            </button>
          )}

          <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 0 8px' }}>投票设置</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, color: 'var(--tm-text-secondary)' }}>选择方式</span>
            {(['single', 'multi'] as const).map((k) => {
              const active = k === 'multi' ? pollForm.multi : !pollForm.multi;
              return (
                <button
                  key={k}
                  type="button"
                  className="tm-press"
                  onClick={() => setPollForm((f) => ({ ...f, multi: k === 'multi' }))}
                  style={{
                    border: 'none',
                    borderRadius: 999,
                    padding: '6px 16px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    background: active ? 'var(--tm-action)' : '#f0f1f3',
                    color: active ? '#fff' : 'var(--tm-text-secondary)',
                  }}
                >
                  {k === 'single' ? '单选' : '多选'}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <span style={{ fontSize: 13.5, color: 'var(--tm-text-secondary)' }}>结束时间</span>
            {[
              { label: '3天', days: 3 },
              { label: '1周', days: 7 },
              { label: '1个月', days: 30 },
            ].map((o) => (
              <button
                key={o.days}
                type="button"
                className="tm-press"
                onClick={() => setPollForm((f) => ({ ...f, durationDays: o.days }))}
                style={{
                  border: 'none',
                  borderRadius: 999,
                  padding: '6px 14px',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: pollForm.durationDays === o.days ? 'var(--tm-action)' : '#f0f1f3',
                  color: pollForm.durationDays === o.days ? '#fff' : 'var(--tm-text-secondary)',
                }}
              >
                {o.label}
              </button>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <InputNumber
                min={1}
                max={365}
                value={pollForm.durationDays}
                onChange={(v) => setPollForm((f) => ({ ...f, durationDays: Number(v) || 7 }))}
                size="small"
                style={{ width: 68 }}
              />
              <span style={{ fontSize: 12.5, color: 'var(--tm-text-tertiary)' }}>天</span>
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
            <Button onClick={() => setPollModalOpen(false)}>取消</Button>
            <Button type="primary" icon={pollDraft ? <CheckOutlined /> : undefined} onClick={confirmPoll}>
              确认
            </Button>
          </div>
        </div>
      </Modal>

      {/* 头图 / 内容图片放大查看 */}
      {viewer &&
        createPortal(
          <div
            onClick={() => setViewer(null)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 300,
              background: 'rgba(15,23,42,.86)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 32,
              cursor: 'zoom-out',
            }}
          >
            <img
              src={viewer}
              alt=""
              style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10, objectFit: 'contain' }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/* 表格块：行内编辑 */
function TableBlock({ b, updateBlock }: { b: EditorBlock; updateBlock: (id: string, patch: Partial<EditorBlock>) => void }) {
  const rows = (b.text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'));
  const cols = rows[0]?.length ?? 3;
  const setCell = (r: number, c: number, v: string) => {
    const next = rows.map((row) => [...row]);
    while (next.length <= r) next.push(Array.from({ length: cols }, () => ''));
    next[r][c] = v;
    updateBlock(b.id, { text: next.map((row) => row.join('|')).join('\n') });
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, minWidth: '100%' }}>
        {rows.map((row, r) => (
          <div key={r} style={{ display: 'flex', gap: 4 }}>
            {row.map((cell, c) => (
              <input
                key={c}
                value={cell}
                onChange={(e) => setCell(r, c, e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 90,
                  border: '1px solid var(--tm-border)',
                  borderRadius: 7,
                  padding: '6px 9px',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  outline: 'none',
                  background: r === 0 ? 'var(--tm-tint)' : '#fff',
                  fontWeight: r === 0 ? 700 : 400,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="tm-press"
        onClick={() => {
          const next = [...rows, Array.from({ length: cols }, () => '')];
          updateBlock(b.id, { text: next.map((row) => row.join('|')).join('\n') });
        }}
        style={{
          marginTop: 6,
          border: 'none',
          background: 'transparent',
          color: 'var(--tm-action)',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
          padding: '2px 0',
        }}
      >
        + 添加行
      </button>
    </div>
  );
}

/* 投票草稿块（发布前） */
function PollDraftBlock({ d, onEdit }: { d: { question: string; options: string[]; multi: boolean } | null; onEdit: () => void }) {
  return (
    <div
      style={{
        border: '1.5px dashed var(--tm-border-strong)',
        borderRadius: 12,
        padding: '13px 16px',
        background: 'var(--tm-tint)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 15 }}>{d?.question || '投票'}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--tm-action)',
            background: 'var(--tm-tint-strong)',
            borderRadius: 5,
            padding: '1.5px 7px',
          }}
        >
          {d?.multi ? '多选' : '单选'}
        </span>
        <button
          type="button"
          className="tm-press"
          onClick={onEdit}
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            color: 'var(--tm-action)',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          编辑
        </button>
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(d?.options ?? []).map((o, j) => (
          <div
            key={j}
            style={{
              border: '1px solid var(--tm-border)',
              background: '#fff',
              borderRadius: 9,
              padding: '8px 12px',
              fontSize: 13.5,
            }}
          >
            {o || `选项 ${j + 1}`}
          </div>
        ))}
      </div>
    </div>
  );
}

