/** 社区帖子共享类型与小工具（列表 / 详情 / 发布 / 预览共用） */

export interface PostItem {
  id: number;
  user_id: number;
  game_id: number | null;
  title: string;
  content: string;
  created_at: string;
  is_pinned: boolean;
  view_count: number;
  game_cover: string | null;
  author_name: string;
  author_role: string;
  author_avatar: string | null;
  is_official: boolean;
  game_name: string | null;
  /** 详情页「相关桌游」卡片（真实字段，列表接口可能不下发） */
  game_name_en?: string | null;
  game_year?: number | null;
  game_category?: string | null;
  like_count: number;
  comment_count: number;
  liked: boolean;
  /** 帖子收藏（真实计数） */
  marked?: boolean;
  mark_count?: number;
  /** 帖子自带图片 / 视频附件 */
  media?: MediaItem[];
  /** 头图区（≤18 张图或 1 个视频，互斥；第一张图即封面） */
  header_media?: MediaItem[];
  header_video?: MediaItem | null;
  /** 列表缩略图：帖内首张图片（头图优先；没有图片则为 null） */
  cover_image?: string | null;
  /** 无图片但有视频时的封面视频 */
  cover_video?: string | null;
  /** 帖子投票（仅详情接口返回） */
  poll?: PollData | null;
}

export interface MediaItem {
  id: number;
  kind: 'image' | 'video';
  slot: 'header' | 'inline';
  url: string;
  sort_order: number;
}

export interface PollOption {
  id: number;
  label: string;
  vote_count: number;
}

export interface PollData {
  id: number;
  question: string;
  multi: boolean;
  end_at: string;
  options: PollOption[];
  total_voters: number;
  my_options: number[];
  expired: boolean;
}

export interface CommentItem {
  id: number;
  post_id: number;
  user_id: number;
  parent_id: number | null;
  content: string;
  created_at: string;
  author_name: string;
  author_role: string;
  author_avatar?: string | null;
  like_count: number;
  dislike_count: number;
  liked: boolean;
  disliked: boolean;
}

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

/** 48 小时内发布的帖子显示 NEW 标记（TapTap 风格） */
export function isNewPost(iso: string): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 48 * 3600 * 1000;
}

/* ── 正文内嵌媒体与块语法 ──
   ![img](url)  图片（连续行合并为图片墙）
   ![video](url) 视频
   ![poll](id)  投票块
   # / ## / ### 标题
   - item       无序列表
   1. item      有序列表
   > quote      引用
   ``` ```      代码块
   ---          分割线
   | a | b |    表格                                    */

const MEDIA_TOKEN = /^!\[(img|video|poll)\]\((.+?)\)$/;

export function mediaToken(kind: 'image' | 'video' | 'poll', url: string): string {
  return `![${kind === 'image' ? 'img' : kind}](${url})`;
}

/** 去掉正文里的媒体 / 投票标记行，得到纯文本（摘要、预览用） */
export function stripMediaTokens(text: string): string {
  return text
    .split('\n')
    .filter((line) => !MEDIA_TOKEN.test(line.trim()))
    .join('\n');
}

/** 摘要：先剥离内嵌媒体标记，再取前 N 字 */
export function excerptOf(text: string, len = 66): string {
  const flat = stripMediaTokens(text).replace(/\s+/g, ' ').trim();
  return flat.length > len ? `${flat.slice(0, len)}…` : flat;
}

export type PostBlock =
  | { type: 'text'; value: string }
  | { type: 'heading'; level: 1 | 2 | 3; value: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; value: string }
  | { type: 'code'; value: string }
  | { type: 'divider' }
  | { type: 'table'; rows: string[][] }
  | { type: 'gallery'; urls: string[] }
  | { type: 'video'; url: string }
  | { type: 'poll'; id: number };

/**
 * 把帖子正文解析成渲染块：标题 / 列表 / 引用 / 代码 / 分割线 / 表格 / 图片墙 / 视频 / 投票。
 * 详情页与发布页预览共用，保证「所见即所得」。
 */
export function parsePostBlocks(content: string): PostBlock[] {
  const lines = content.split('\n');
  const blocks: PostBlock[] = [];
  let i = 0;
  const pushText = (line: string) => {
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') last.value += `\n${line}`;
    else blocks.push({ type: 'text', value: line });
  };

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) {
      i += 1;
      continue;
    }
    // 代码块围栏
    if (t.startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏
      blocks.push({ type: 'code', value: buf.join('\n') });
      continue;
    }
    // 媒体 / 投票标记
    const m = MEDIA_TOKEN.exec(t);
    if (m) {
      if (m[1] === 'video') blocks.push({ type: 'video', url: m[2] });
      else if (m[1] === 'poll') blocks.push({ type: 'poll', id: Number(m[2]) });
      else blocks.push({ type: 'gallery', urls: [m[2]] });
      i += 1;
      continue;
    }
    // 分割线
    if (/^-{3,}$/.test(t)) {
      blocks.push({ type: 'divider' });
      i += 1;
      continue;
    }
    // 标题
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, value: h[2] });
      i += 1;
      continue;
    }
    // 引用（连续行合并）
    if (t.startsWith('>')) {
      const buf: string[] = [t.replace(/^>\s?/, '')];
      i += 1;
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', value: buf.join('\n') });
      continue;
    }
    // 表格（连续 | 行）
    if (t.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        // 跳过 |---|---| 分隔行
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
        i += 1;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    // 无序 / 有序列表（连续行）
    if (/^-\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const lt = lines[i].trim();
        const mm = /^-\s+(.*)$/.exec(lt);
        if (!mm) break;
        items.push(mm[1]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }
    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const lt = lines[i].trim();
        const mm = /^\d+\.\s+(.*)$/.exec(lt);
        if (!mm) break;
        items.push(mm[1]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }
    pushText(raw);
    i += 1;
  }

  // 合并相邻图片 → 图片墙
  const out: PostBlock[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === 'gallery' && last && last.type === 'gallery') last.urls.push(...b.urls);
    else out.push(b.type === 'gallery' ? { type: 'gallery', urls: [...b.urls] } : b);
  }
  return out;
}

/* ── 编辑器块（发布页） ── */

export type EditorBlockType =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'ul'
  | 'ol'
  | 'quote'
  | 'code'
  | 'divider'
  | 'image'
  | 'video'
  | 'table'
  | 'poll';

export interface EditorBlock {
  id: string;
  type: EditorBlockType;
  /** p / h1-h3 / ul / ol / quote / code / table（表格为管道分隔行） */
  text?: string;
  /** image / video */
  url?: string;
  /** 已上传附件的记录 id（发帖时绑定用） */
  mediaId?: number;
  /** poll（发布前用 -1 占位，后端创建后回填真实 id） */
  pollId?: number;
}

export function newBlock(type: EditorBlockType, extra: Partial<EditorBlock> = {}): EditorBlock {
  return { id: `b${Date.now()}${Math.random().toString(36).slice(2, 7)}`, type, text: '', ...extra };
}

/** 编辑器块 → 正文文本（与 parsePostBlocks 的语法一一对应） */
export function serializeBlocks(blocks: EditorBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const text = (b.text ?? '').replace(/\s+$/, '');
    switch (b.type) {
      case 'p':
        if (text.trim()) lines.push(text);
        break;
      case 'h1':
        if (text.trim()) lines.push(`# ${text.trim()}`);
        break;
      case 'h2':
        if (text.trim()) lines.push(`## ${text.trim()}`);
        break;
      case 'h3':
        if (text.trim()) lines.push(`### ${text.trim()}`);
        break;
      case 'ul':
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => lines.push(`- ${s}`));
        break;
      case 'ol':
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s, idx) => lines.push(`${idx + 1}. ${s}`));
        break;
      case 'quote':
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => lines.push(`> ${s}`));
        break;
      case 'code':
        if (text.trim()) lines.push('```', text, '```');
        break;
      case 'divider':
        lines.push('---');
        break;
      case 'table':
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => lines.push(s.startsWith('|') ? s : `| ${s} |`));
        break;
      case 'image':
        if (b.url) lines.push(mediaToken('image', b.url));
        break;
      case 'video':
        if (b.url) lines.push(mediaToken('video', b.url));
        break;
      case 'poll':
        // 未发布前用 ![poll](0) 占位，后端创建投票后回填真实 id
        lines.push(mediaToken('poll', String(b.pollId && b.pollId > 0 ? b.pollId : 0)));
        break;
    }
  }
  return lines.join('\n');
}

/** 把纯文本（导入的 md / txt）解析为编辑器块 */
export function blocksFromText(text: string): EditorBlock[] {
  const blocks: EditorBlock[] = [];
  for (const b of parsePostBlocks(text)) {
    switch (b.type) {
      case 'text':
        blocks.push(newBlock('p', { text: b.value }));
        break;
      case 'heading':
        blocks.push(newBlock(`h${b.level}` as EditorBlockType, { text: b.value }));
        break;
      case 'list':
        blocks.push(newBlock(b.ordered ? 'ol' : 'ul', { text: b.items.join('\n') }));
        break;
      case 'quote':
        blocks.push(newBlock('quote', { text: b.value }));
        break;
      case 'code':
        blocks.push(newBlock('code', { text: b.value }));
        break;
      case 'divider':
        blocks.push(newBlock('divider'));
        break;
      case 'table':
        blocks.push(newBlock('table', { text: b.rows.map((r) => r.join('|')).join('\n') }));
        break;
      case 'gallery':
        b.urls.forEach((u) => blocks.push(newBlock('image', { url: u })));
        break;
      case 'video':
        blocks.push(newBlock('video', { url: b.url }));
        break;
      case 'poll':
        blocks.push(newBlock('poll', { pollId: b.id }));
        break;
    }
  }
  return blocks;
}
