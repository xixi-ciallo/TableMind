import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Divider, Drawer, Dropdown, Empty, Input, InputNumber, Popconfirm, Select, Spin, Tag, message } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  ArrowLeftOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  HeartOutlined,
  HistoryOutlined,
  LoadingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReadOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UserOutlined,
  CompassOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import client from '../../shared/api/client';
import { ACTION, BRAND, INFO, LINK, TEXT_SECONDARY, TEXT_TERTIARY } from '../../shared/theme';
import { useIsMobile } from '../../shared/useIsMobile';
import { useAuthStore } from '../../stores/auth';

const { TextArea } = Input;

/* ────────────────────────────  静态内容  ──────────────────────────── */

/** 回答模式：二选一互斥——「快速」给要点，「深度」展开更多真实字段 */
const MODES = [
  {
    key: 'fast' as const,
    label: '快速',
    icon: <ThunderboltOutlined />,
    hint: '只给要点：人数、时长与一句话简介',
    border: 'rgba(255,107,69,.45)',
    color: LINK,
  },
  {
    key: 'deep' as const,
    label: '深度',
    icon: <HistoryOutlined />,
    hint: '多给几款，并展开适龄、复杂度、分类与机制',
    border: 'rgba(14,127,184,.45)',
    color: INFO,
  },
];

type ModeKey = (typeof MODES)[number]['key'];

/** Agent 工具名 → 给用户的中文提示，避免把内部函数名暴露在界面上 */
const TOOL_LABEL: Record<string, string> = {
  get_rule_chunks: '正在查阅规则说明书…',
  search_games: '正在检索桌游库…',
  get_game_detail: '正在查询游戏资料…',
  get_user_collection: '正在查看你的收藏…',
  random_picks: '正在挑选桌游…',
};

/** 「你可能想问」：按意图分组，点击直接发送。每个分组带图标与配色，帮用户快速看出 AI 能做什么。 */
interface SuggestionGroup {
  key: string;
  label: string;
  icon: ReactNode;
  /** 分组强调色（仅用于图标与 hover 描边，不承载白字，故可用高亮色） */
  accent: string;
  items: string[];
}

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    key: 'rule',
    label: '规则查询',
    icon: <ReadOutlined />,
    accent: INFO,
    items: [
      '卡坦岛 3 人局怎么开局布局？',
      '《七大奇迹：对决》怎么算分取胜？',
      '花砖物语一轮该怎么摆瓷砖？',
      '《幽港迷城》上手难度真的很高吗？',
      '三国杀主公身份该怎么玩？',
    ],
  },
  {
    key: 'recommend',
    label: '挑桌游',
    icon: <CompassOutlined />,
    accent: LINK,
    items: [
      '推荐几款 4 人 45 分钟以内的德式桌游',
      '有哪些适合和爸妈一起玩的桌游？',
      '今晚 3 个人想玩点轻策，有推荐吗？',
    ],
  },
  {
    key: 'compare',
    label: '游戏对比',
    icon: <SwapOutlined />,
    accent: '#7c5cff',
    items: [
      '瘟疫危机和它的传承版有什么区别？',
      '阿瓦隆和一夜终极狼人哪个更适合新手？',
      '卡卡颂和王国米诺哪个更适合家庭？',
    ],
  },
  {
    key: 'random',
    label: '随手挑',
    icon: <ThunderboltOutlined />,
    accent: ACTION,
    items: ['帮我随机挑 3 款今天能开局的桌游'],
  },
];

/** 登录后追加「我的收藏」分组：AI 可读取用户收藏后再作答 */
const COLLECTION_GROUP: SuggestionGroup = {
  key: 'collection',
  label: '我的收藏',
  icon: <HeartOutlined />,
  accent: BRAND,
  items: [
    '我收藏的桌游里有哪些适合 4 人玩？',
    '我收藏的游戏里哪款复杂度最高？',
  ],
};

interface Message {
  role: 'assistant' | 'user';
  content: string;
}

interface SessionItem {
  session_id: number;
  created_at: string;
  last_at: string;
  message_count: number;
  preview: string;
}

/** 我的偏好：分类/机制候选（仅作输入提示，用户也可自由输入） */
const CATEGORY_OPTIONS = [
  '策略', '德式', '美式', '家庭', '派对', '合作', '轻策', '重策', '推理', '抽象', '入门',
];
const MECHANIC_OPTIONS = [
  '卡牌驱动', '区域控制', '工人放置', '骰子', '角色扮演', '推理', '拍卖', '牌库构筑', '路线规划', '合作',
];

/** 历史时间：今天只显示时分，其余显示月-日 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ────────────────────────────  页面  ──────────────────────────── */

export default function AiAssistantPage() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const loggedIn = !!token;

  // 空态不预设任何助手气泡：用户提问后才出现「正在思考…」并流式输出
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ModeKey>('fast');
  const [sessionId, setSessionId] = useState<number | null>(null);
  /** 等待后端返回 / 流式输出期间为 true */
  const [busy, setBusy] = useState(false);
  /** 推理模型的思维链阶段：还没吐出正文 */
  const [thinking, setThinking] = useState(false);
  /** Agent 正在调用的工具提示文案，非空时气泡显示「正在查询…」 */
  const [toolName, setToolName] = useState<string | null>(null);
  /** 规则问答的依据层级标签（L1结构化 / L2规则书 / L3 BGG / L4未验证），如实展示来源 */
  const [levelLabel, setLevelLabel] = useState<string | null>(null);
  /** 本次请求已用时（秒），busy 期间每 100ms 实时刷新 */
  const [elapsed, setElapsed] = useState(0);
  /** 上一次请求的总耗时（秒），完成后保留在头部展示 */
  const [lastCost, setLastCost] = useState<number | null>(null);
  /** 本次请求起始时间戳，用于结束时算总耗时（避免闭包读到旧 state） */
  const startRef = useRef(0);
  /** 后端大模型接入情况，决定底部说明文案 */
  const [llm, setLlm] = useState<{ llm_enabled: boolean; model: string | null } | null>(null);
  /** 桌面端页面内左栏折叠 */
  const [collapsed, setCollapsed] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  /* ── 我的偏好（个性化记忆）：与 RAG 语义记忆分开存/取 ── */
  const [prefOpen, setPrefOpen] = useState(false);
  const [prefLoading, setPrefLoading] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);
  const [prefEpisodes, setPrefEpisodes] = useState<{ id: number; kind: string; content: string; created_at: string }[]>([]);
  const [pCats, setPCats] = useState<string[]>([]);
  const [pMechs, setPMechs] = useState<string[]>([]);
  const [pDislikes, setPDislikes] = useState<string[]>([]);
  const [pPpc, setPPpc] = useState<number | null>(null);
  const [pMaxC, setPMaxC] = useState<number | null>(null);
  const [pNotes, setPNotes] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<TextAreaRef>(null);
  const timerRef = useRef<number | null>(null);

  const started = messages.some((m) => m.role === 'user');

  const stopTyping = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setBusy(false);
  };

  useEffect(() => stopTyping, []);

  /** busy 期间实时计时：思考中 / 生成中都能看到已用时 */
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => window.clearInterval(id);
  }, [busy]);

  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages]);

  const loadHistory = async () => {
    if (!loggedIn) return;
    setHistoryLoading(true);
    try {
      const { data } = await client.get<SessionItem[]>('/ai/history', { params: { limit: 30 } });
      setSessions(data);
    } catch {
      setSessions([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  /** 删除单条历史会话；正在看这条时顺带回到空态 */
  const removeSession = async (id: number) => {
    try {
      await client.delete(`/ai/history/${id}`);
      if (sessionId === id) reset();
      await loadHistory();
    } catch {
      /* 失败时列表保持原样，可重试 */
    }
  };

  /** 清空全部历史会话 */
  const clearAll = async () => {
    try {
      await client.delete('/ai/history');
      reset();
      await loadHistory();
    } catch {
      /* 同上 */
    }
  };

  /** 打开一条历史会话 */
  const openSession = async (id: number) => {
    stopTyping();
    try {
      const { data } = await client.get<Message[]>(`/ai/history/${id}`);
      setMessages(data.length ? data : []);
      setSessionId(id);
      setHistoryOpen(false);
    } catch {
      setHistoryOpen(false);
    }
  };

  /** 打开「我的偏好」抽屉并加载个性化记忆 */
  const openPref = () => {
    if (!loggedIn) {
      message.warning('登录后可管理偏好，AI 会据此个性化推荐');
      return;
    }
    setPrefOpen(true);
    void loadMemory();
  };

  /** 读取我的偏好画像 + 近期情景记忆 */
  const loadMemory = async () => {
    setPrefLoading(true);
    try {
      const { data } = await client.get<{
        profile: {
          preferred_categories: string[];
          preferred_mechanics: string[];
          disliked_games: string[];
          max_complexity: number | null;
          preferred_player_count: number | null;
          notes: string;
        };
        episodes: { id: number; kind: string; content: string; created_at: string }[];
      }>('/ai/memory');
      const p = data.profile;
      setPCats(p.preferred_categories || []);
      setPMechs(p.preferred_mechanics || []);
      setPDislikes(p.disliked_games || []);
      setPMaxC(p.max_complexity ?? null);
      setPPpc(p.preferred_player_count ?? null);
      setPNotes(p.notes || '');
      setPrefEpisodes(data.episodes || []);
    } catch {
      message.error('加载偏好失败');
    } finally {
      setPrefLoading(false);
    }
  };

  /** 保存我的偏好画像（合并式，与对话自动蒸馏走同一套后端逻辑） */
  const saveMemory = async () => {
    setPrefSaving(true);
    try {
      await client.put('/ai/memory', {
        preferred_categories: pCats,
        preferred_mechanics: pMechs,
        disliked_games: pDislikes,
        max_complexity: pMaxC,
        preferred_player_count: pPpc,
        notes: pNotes.trim(),
      });
      message.success('已保存偏好');
      await loadMemory();
    } catch {
      message.error('保存失败，请重试');
    } finally {
      setPrefSaving(false);
    }
  };

  /** 清空我的全部个性化记忆 */
  const clearMemory = async () => {
    try {
      await client.delete('/ai/memory');
      message.success('已清空偏好');
      setPrefOpen(false);
    } catch {
      message.error('清空失败');
    }
  };

  /** 深链：/ai?session=<id> 直接打开某次历史对话 */
  useEffect(() => {
    const sid = Number(searchParams.get('session'));
    if (!loggedIn || !Number.isInteger(sid) || sid <= 0) return;
    void openSession(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, searchParams]);

  /** 登录后自动拉一次历史，左栏直接有内容 */
  useEffect(() => {
    if (loggedIn) void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  /** 大模型接入状态（公开接口，未登录也能拿） */
  useEffect(() => {
    client
      .get<{ llm_enabled: boolean; model: string | null }>('/ai/status')
      .then(({ data }) => setLlm(data))
      .catch(() => setLlm(null));
  }, []);

  /** 把一段文本追加到最后一条助手消息上（流式逐段到达） */
  const appendAssistant = (delta: string) => {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { role: 'assistant', content: last.content + delta };
      } else {
        next.push({ role: 'assistant', content: delta });
      }
      return next;
    });
  };

  /** 清空最后一条助手消息（大模型中途失败、改用降级结果时） */
  const clearLastAssistant = () => {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { role: 'assistant', content: '' };
      }
      return next;
    });
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    if (!loggedIn) {
      navigate('/login');
      return;
    }

    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]);
    setBusy(true);
    setThinking(true);
    setToolName(null);
    setLevelLabel(null);
    startRef.current = Date.now();

    try {
      // SSE 流式：axios 不支持流，这里直接用 fetch 读 ReadableStream
      const resp = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ session_id: sessionId, message: text, mode }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let received = false;

      const handleBlock = (block: string) => {
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }

        if (event === 'meta') {
          const sid = payload.session_id;
          if (typeof sid === 'number') setSessionId(sid);
        } else if (event === 'thinking') {
          setThinking(true);
        } else if (event === 'tool') {
          const name = String(payload.text ?? '');
          setToolName(TOOL_LABEL[name] ?? '正在查询资料…');
          setThinking(false);
        } else if (event === 'delta') {
          const delta = String(payload.text ?? '');
          if (delta) {
            received = true;
            setThinking(false);
            setToolName(null);
            appendAssistant(delta);
          }
        } else if (event === 'info') {
          // 提示性信息（如「协同过滤未启用」）：只做提示，绝不清理已生成内容
          const info = String(payload.text ?? '');
          if (info) {
            setToolName(info);
            setThinking(false);
          }
        } else if (event === 'level') {
          // 规则问答的依据层级，如实标注来源，让用户知道这段有没有原文依据
          const lb = payload.label;
          if (typeof lb === 'string') setLevelLabel(lb);
        } else if (event === 'notice') {
          // 大模型失败已降级：清掉半截内容，等降级结果流过来
          clearLastAssistant();
          setThinking(false);
        } else if (event === 'done') {
          const sid = payload.session_id;
          if (typeof sid === 'number') setSessionId(sid);
        }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          handleBlock(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
      if (buf.trim()) handleBlock(buf);

      if (!received) {
        appendAssistant('抱歉，这次没能取到回答。请稍后重试，或换个说法再问一次。');
      }
      void loadHistory();
    } catch {
      // 请求层失败（网络/鉴权/服务端 5xx）：给出可操作的提示
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && !last.content) {
        appendAssistant('抱歉，这次没能取到回答。请检查网络后重试，或换个说法再问一次。');
      }
    } finally {
      setLastCost((Date.now() - startRef.current) / 1000);
      setBusy(false);
      setThinking(false);
    }
  };

  const reset = () => {
    stopTyping();
    setMessages([]);
    setSessionId(null);
    setInput('');
  };

  const canSend = input.trim().length > 0 && !busy;

  /** 返回：无历史记录时回首页，避免点了没反应 */
  const goBack = () => (location.key === 'default' ? navigate('/') : navigate(-1));

  /* ── 共用：输入器（Hero 与会话态复用，只差尺寸） ── */
  const composer = (hero: boolean) => (
    <div
      style={{
        background: '#fdf3ef',
        border: '1px solid transparent',
        borderRadius: 20,
        padding: hero ? '18px 20px 14px' : '12px 16px 10px',
        transition:
          'background-color .2s var(--tm-ease), border-color .2s var(--tm-ease), box-shadow .2s var(--tm-ease)',
      }}
      onFocusCapture={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.background = '#fff';
        el.style.borderColor = 'rgba(255,107,69,.45)';
        el.style.boxShadow = '0 8px 26px rgba(255,107,69,.14)';
      }}
      onBlurCapture={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.background = '#fdf3ef';
        el.style.borderColor = 'transparent';
        el.style.boxShadow = 'none';
      }}
    >
      <TextArea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onPressEnter={(e) => {
          if (!e.shiftKey) {
            e.preventDefault();
            void send(input);
          }
        }}
        placeholder="玩游戏，有规则问题就找我～"
        aria-label="输入你想咨询的桌游问题"
        autoSize={{ minRows: hero ? 2 : 1, maxRows: hero ? 8 : 6 }}
        variant="borderless"
        style={{ fontSize: hero ? 15.5 : 15, lineHeight: 1.65, padding: 0, resize: 'none' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        {/* 快速 / 深度：二选一互斥，切换会随请求一起发给后端 */}
        {MODES.map((m) => {
          const on = mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={on}
              title={m.hint}
              onClick={() => setMode(m.key)}
              className="tm-press"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: `1px solid ${on ? m.border : 'var(--tm-border-strong)'}`,
                background: on ? m.key === 'deep' ? 'var(--tm-info-tint)' : 'var(--tm-tint)' : '#fff',
                color: on ? m.color : TEXT_SECONDARY,
                borderRadius: 999,
                padding: '6px 15px',
                fontSize: 13,
                fontWeight: on ? 600 : 400,
                fontFamily: 'inherit',
                cursor: 'pointer',
                boxShadow: on ? '0 2px 8px rgba(17,24,39,.06)' : 'none',
                transition: 'all .18s var(--tm-ease)',
              }}
            >
              {m.icon}
              {m.label}
            </button>
          );
        })}

        {/* 右下圆形发送：空输入时同色降透明，不切成灰色 */}
        <button
          type="button"
          aria-label={busy ? '正在生成回答' : '发送'}
          onClick={() => void send(input)}
          disabled={!canSend}
          className="tm-press"
          style={{
            marginLeft: 'auto',
            width: 44,
            height: 44,
            flexShrink: 0,
            border: 'none',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 17,
            cursor: canSend ? 'pointer' : 'not-allowed',
            background: `linear-gradient(135deg, ${BRAND}, ${ACTION})`,
            opacity: canSend ? 1 : 0.4,
            boxShadow: canSend ? '0 6px 16px rgba(217,61,26,.28)' : 'none',
            transition: 'opacity .2s var(--tm-ease), box-shadow .2s var(--tm-ease)',
          }}
        >
          {busy ? <LoadingOutlined /> : <ArrowUpOutlined />}
        </button>
      </div>
    </div>
  );

  /* ── 桌面端页面内左栏：logo / 开启新对话 / 收藏 / 历史会话 / 当前用户 ── */
  const sidebar = (
    <aside
      style={{
        width: collapsed ? 76 : 260,
        flexShrink: 0,
        background: '#fafbfc',
        borderRight: '1px solid var(--tm-border)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width .2s var(--tm-ease-out)',
      }}
    >
      {/* 返回 + 标识 + 折叠 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: collapsed ? '14px 0 10px' : '14px 12px 10px',
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        <button
          type="button"
          onClick={goBack}
          aria-label="返回"
          title="返回"
          className="tm-press"
          style={{
            flexShrink: 0,
            border: '1px solid var(--tm-border-strong)',
            background: '#fff',
            color: TEXT_SECONDARY,
            borderRadius: 999,
            height: 28,
            padding: collapsed ? '0 8px' : '0 12px 0 10px',
            fontSize: 12.5,
            fontFamily: 'inherit',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <ArrowLeftOutlined style={{ fontSize: 11 }} />
          {!collapsed && '返回'}
        </button>
        {!collapsed && (
          /* 名称占满剩余宽度并可截断，保证折叠按钮始终完整显示 */
          <span
            className="tm-clamp-1"
            style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 800 }}
          >
            TableMind AI
          </span>
        )}
        {/* 收起 / 展开：固定尺寸不参与收缩，避免被挤压裁切 */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          className="tm-press"
          style={{
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            color: TEXT_SECONDARY,
            width: 28,
            height: 28,
            borderRadius: 8,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 15,
          }}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>
      </div>

      {/* 开启新对话 */}
      <div style={{ padding: '10px 14px' }}>
        <button
          type="button"
          onClick={reset}
          title="开启新对话"
          className="tm-press"
          style={{
            /* 折叠态收成一个圆形图标按钮，居中不撑满 */
            width: collapsed ? 40 : '100%',
            margin: collapsed ? '0 auto' : undefined,
            height: collapsed ? 40 : 36,
            border: '1px solid var(--tm-border-strong)',
            borderRadius: collapsed ? '50%' : 10,
            background: '#fff',
            boxShadow: 'var(--tm-shadow-xs)',
            color: 'var(--tm-text-primary)',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <ReloadOutlined />
          {!collapsed && '开启新对话'}
        </button>
      </div>

      {/* 历史会话标题 */}
      {!collapsed && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 14px 6px' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: TEXT_SECONDARY }}>历史会话</span>
          <button
            type="button"
            onClick={() => void loadHistory()}
            aria-label="刷新历史会话"
            title="刷新"
            className="tm-press"
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'transparent',
              color: TEXT_TERTIARY,
              width: 24,
              height: 24,
              borderRadius: 7,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
            }}
          >
            <SyncOutlined spin={historyLoading} />
          </button>
          {sessions.length > 0 && (
            <Popconfirm
              title="清空全部历史会话？"
              description="删除后无法恢复"
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void clearAll()}
            >
              <button
                type="button"
                aria-label="清空历史会话"
                title="清空历史会话"
                className="tm-press"
                style={{
                  marginLeft: 2,
                  border: 'none',
                  background: 'transparent',
                  color: TEXT_TERTIARY,
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                }}
              >
                <DeleteOutlined />
              </button>
            </Popconfirm>
          )}
        </div>
      )}

      {/* 历史列表 / 空态 */}
      <div
        className="tm-rank-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: collapsed ? '12px 8px' : '0 10px 8px',
        }}
      >
        {!loggedIn ? (
          !collapsed && (
            <div style={{ fontSize: 12.5, color: TEXT_TERTIARY, padding: '6px 4px', lineHeight: 1.7 }}>
              登录后可查看历史会话
            </div>
          )
        ) : sessions.length === 0 ? (
          !collapsed && (
            <div style={{ fontSize: 12.5, color: TEXT_TERTIARY, padding: '6px 4px' }}>
              {historyLoading ? '加载中…' : '暂无历史'}
            </div>
          )
        ) : (
          sessions.map((s) => (
            <div key={s.session_id} className="tm-hist-row" style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => void openSession(s.session_id)}
                title={s.preview}
                style={{
                  width: '100%',
                  textAlign: collapsed ? 'center' : 'left',
                  border: `1px solid ${s.session_id === sessionId ? 'rgba(255,107,69,.4)' : 'transparent'}`,
                  background: s.session_id === sessionId ? 'var(--tm-tint)' : 'transparent',
                  borderRadius: 9,
                  padding: collapsed ? '8px 0' : '8px 26px 8px 9px',
                  marginBottom: 2,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  transition: 'background .16s var(--tm-ease)',
                }}
                onMouseEnter={(e) => {
                  if (s.session_id !== sessionId) e.currentTarget.style.background = '#f2f3f5';
                }}
                onMouseLeave={(e) => {
                  if (s.session_id !== sessionId) e.currentTarget.style.background = 'transparent';
                }}
              >
                {collapsed ? (
                  <HistoryOutlined style={{ fontSize: 14, color: TEXT_SECONDARY }} />
                ) : (
                  <>
                    <div
                      className="tm-clamp-1"
                      style={{ fontSize: 13, color: 'var(--tm-text-primary)', lineHeight: 1.5 }}
                    >
                      {s.preview || '（空会话）'}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 11.5, color: TEXT_TERTIARY }}>
                      {formatWhen(s.last_at)} · {s.message_count} 条
                    </div>
                  </>
                )}
              </button>
              {/* 删除：悬停该行才显形，二次确认后删除 */}
              {!collapsed && (
                <Popconfirm
                  title="删除这条对话？"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void removeSession(s.session_id)}
                >
                  <button
                    type="button"
                    aria-label="删除这条对话"
                    className="tm-hist-del tm-press"
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 5,
                      width: 20,
                      height: 20,
                      border: 'none',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,.92)',
                      color: TEXT_SECONDARY,
                      fontSize: 11,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <CloseOutlined />
                  </button>
                </Popconfirm>
              )}
            </div>
          ))
        )}
      </div>

      {/* 底部：当前用户 + 设置 */}
      <div
        style={{
          borderTop: '1px solid var(--tm-border)',
          padding: collapsed ? '10px 0' : '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        {loggedIn ? (
          /* 点击用户区弹出功能菜单：个人中心 / 收藏 / 评测 / 退出登录 */
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            menu={{
              items: [
                { key: 'profile', icon: <UserOutlined />, label: '个人中心' },
                { key: 'collections', icon: <HeartOutlined />, label: '我的收藏' },
                { key: 'reviews', icon: <EditOutlined />, label: '我的评测' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'logout') {
                  logout();
                  navigate('/');
                } else if (key === 'profile') {
                  navigate('/profile');
                } else {
                  navigate(`/profile?tab=${key}`);
                }
              },
            }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-label="账号菜单"
              title="账号菜单"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                width: '100%',
                cursor: 'pointer',
                justifyContent: collapsed ? 'center' : 'flex-start',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: '#eceef1',
                  color: TEXT_SECONDARY,
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {user?.avatar ? (
                  <img
                    src={user.avatar}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <UserOutlined />
                )}
              </span>
              {!collapsed && (
                <>
                  <span
                    className="tm-clamp-1"
                    style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--tm-text-primary)' }}
                  >
                    {user?.username || '已登录'}
                  </span>
                  <SettingOutlined style={{ color: TEXT_TERTIARY, fontSize: 14, flexShrink: 0 }} />
                </>
              )}
            </div>
          </Dropdown>
        ) : (
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="tm-press"
            style={{
              border: 'none',
              background: ACTION,
              color: '#fff',
              borderRadius: 999,
              padding: collapsed ? '6px 8px' : '6px 16px',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {collapsed ? <UserOutlined /> : '登录 / 注册'}
          </button>
        )}
      </div>
    </aside>
  );

  /* ── 空态：居中头像组 + 输入器 + 你可能想问 ── */
  const hero = (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: isMobile ? '20px 16px 16px' : '7vh 24px 20px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', flex: 1 }}>
        {/* 头像 + 名称：作为一组整体居中 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 13,
            justifyContent: 'center',
            marginBottom: 24,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              padding: 2,
              background: `conic-gradient(from 210deg, ${BRAND}, #ffb08a, ${ACTION}, ${BRAND})`,
              display: 'flex',
              flexShrink: 0,
              boxShadow: '0 8px 22px rgba(255,107,69,.22)',
            }}
          >
            <span
              style={{
                flex: 1,
                borderRadius: '50%',
                background: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {/* 渐变文字必须落在纯文本节点上，否则 background-clip 会铺满整个圆形 */}
              <span
                style={{
                  fontWeight: 800,
                  fontSize: 18,
                  letterSpacing: '-0.5px',
                  backgroundImage: `linear-gradient(135deg, ${BRAND}, ${ACTION})`,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                AI
              </span>
            </span>
          </span>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>TableMind AI</div>
            <div style={{ color: TEXT_SECONDARY, fontSize: 12.5, marginTop: 2 }}>
              最懂你的桌游 AI 助手
            </div>
          </div>
        </div>

        {composer(true)}

        {!loggedIn && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 12,
              padding: '9px 14px',
              borderRadius: 12,
              background: 'var(--tm-tint)',
              color: TEXT_SECONDARY,
              fontSize: 13,
            }}
          >
            <span style={{ flex: 1 }}>登录后即可与 AI 对话，对话记录会保存在你的账号里。</span>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="tm-press"
              style={{
                border: 'none',
                background: ACTION,
                color: '#fff',
                borderRadius: 999,
                padding: '5px 14px',
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              去登录
            </button>
          </div>
        )}

        {/* 你可能想问 */}
        <div style={{ marginTop: 30, width: '100%' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_SECONDARY, marginBottom: 14 }}>
            你可能想问:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[...(loggedIn ? [...SUGGESTION_GROUPS, COLLECTION_GROUP] : SUGGESTION_GROUPS)].map((g) => (
              <div key={g.key}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    marginBottom: 9,
                  }}
                >
                  <span style={{ color: g.accent, display: 'inline-flex', fontSize: 15 }} aria-hidden>
                    {g.icon}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)' }}>
                    {g.label}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {g.items.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      style={{
                        textAlign: 'left',
                        border: '1px solid var(--tm-border)',
                        background: '#f7f8fa',
                        color: 'var(--tm-text-primary)',
                        borderRadius: 999,
                        padding: '7px 13px',
                        fontSize: 12.5,
                        lineHeight: 1.4,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        transition: 'all .18s var(--tm-ease)',
                      }}
                      onMouseEnter={(e) => {
                        const el = e.currentTarget;
                        el.style.background = 'var(--tm-tint)';
                        el.style.borderColor = g.accent;
                        el.style.color = LINK;
                        el.style.transform = 'translateY(-2px)';
                        el.style.boxShadow = '0 6px 16px rgba(17,24,39,.08)';
                      }}
                      onMouseLeave={(e) => {
                        const el = e.currentTarget;
                        el.style.background = '#f7f8fa';
                        el.style.borderColor = 'var(--tm-border)';
                        el.style.color = 'var(--tm-text-primary)';
                        el.style.transform = 'none';
                        el.style.boxShadow = 'none';
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 底部说明：贴到内容区底部居中 */}
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 28,
            textAlign: 'center',
            color: TEXT_TERTIARY,
            fontSize: 12,
          }}
        >
          {llm?.llm_enabled && llm.model
            ? `由 ${llm.model} 基于本站真实收录资料生成 · 规则细节请以官方说明书为准`
            : '回答基于本站真实收录的桌游资料（大模型未接入）· 规则细节请以官方说明书为准'}
        </div>
      </div>
    </div>
  );

  /* ── 会话态：消息流 + 底部输入器 ── */
  const chat = (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: isMobile ? '10px 16px' : '12px 24px',
          borderBottom: '1px solid var(--tm-border)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            flexShrink: 0,
            background: `linear-gradient(135deg, ${BRAND}, ${ACTION})`,
            color: '#fff',
            fontSize: 12,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          AI
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.2 }}>TableMind AI</div>
          <div style={{ color: TEXT_TERTIARY, fontSize: 11.5 }}>
            {busy
              ? toolName ??
                (thinking
                  ? `正在思考… ${elapsed.toFixed(1)}s`
                  : `正在生成… ${elapsed.toFixed(1)}s`)
              : lastCost != null
                ? `已就绪 · 上次用时 ${lastCost.toFixed(1)}s`
                : '已就绪'}
          </div>
          {levelLabel ? (
            <div
              style={{
                marginTop: 3,
                display: 'inline-block',
                fontSize: 11,
                color: '#a8552a',
                background: 'rgba(255,107,69,0.10)',
                border: '1px solid rgba(255,107,69,0.28)',
                borderRadius: 6,
                padding: '1px 6px',
              }}
            >
              {levelLabel}
            </div>
          ) : null}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => (isMobile ? setHistoryOpen(true) : setCollapsed((v) => !v))}
            className="tm-press"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--tm-border-strong)',
              background: '#fff',
              color: TEXT_SECONDARY,
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <HistoryOutlined />
            {isMobile ? '' : '历史会话'}
          </button>
          <button
            type="button"
            onClick={openPref}
            className="tm-press"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--tm-border-strong)',
              background: '#fff',
              color: TEXT_SECONDARY,
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <UserOutlined />
            {isMobile ? '' : '我的偏好'}
          </button>
          <button
            type="button"
            onClick={reset}
            className="tm-press"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--tm-border-strong)',
              background: '#fff',
              color: TEXT_SECONDARY,
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <ReloadOutlined />
            {isMobile ? '' : '开启新对话'}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="对话消息"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: isMobile ? '16px 16px 8px' : '18px 24px 8px',
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 10,
              marginBottom: 18,
              flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 800,
                background:
                  m.role === 'assistant' ? `linear-gradient(135deg, ${BRAND}, ${ACTION})` : '#f0f1f3',
                color: m.role === 'assistant' ? '#fff' : TEXT_SECONDARY,
              }}
            >
              {m.role === 'assistant' ? 'AI' : <UserOutlined />}
            </span>
            <div
              style={{
                maxWidth: '78%',
                padding: '11px 16px',
                borderRadius: 14,
                fontSize: 14,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: m.role === 'assistant' ? '#f7f8fa' : ACTION,
                color: m.role === 'assistant' ? 'var(--tm-text-primary)' : '#fff',
                borderTopLeftRadius: m.role === 'assistant' ? 4 : 14,
                borderTopRightRadius: m.role === 'user' ? 4 : 14,
              }}
            >
              {m.content ||
                (toolName && i === messages.length - 1 ? (
                  <span style={{ color: TEXT_TERTIARY, fontSize: 13 }}>{toolName}</span>
                ) : thinking && i === messages.length - 1 ? (
                  <span style={{ color: TEXT_TERTIARY, fontSize: 13 }}>
                    正在思考… {elapsed.toFixed(1)}s
                  </span>
                ) : (
                  <span aria-label="正在生成" style={{ display: 'inline-flex', gap: 4 }}>
                    {[0, 1, 2].map((d) => (
                      <i
                        key={d}
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: BRAND,
                          animation: `tm-fade-in .6s ${d * 0.15}s infinite alternate`,
                        }}
                      />
                    ))}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: isMobile ? '8px 16px 12px' : '10px 24px 16px' }}>{composer(false)}</div>
    </>
  );

  return (
    <>
      {isMobile ? (
        <div
          style={{
            height: 'calc(100dvh - 84px)',
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
          }}
        >
          {started ? chat : hero}
        </div>
      ) : (
        <div style={{ height: 'calc(100vh - 64px)', display: 'flex', background: '#fff' }}>
          {sidebar}
          <main
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              background: '#fff',
            }}
          >
            {started ? chat : hero}
          </main>
        </div>
      )}

      {/* 移动端历史会话入口（桌面端历史常驻左栏） */}
      <Drawer
        title="历史会话"
        placement="right"
        width="86%"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        styles={{ body: { padding: 12 } }}
      >
        {historyLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin />
          </div>
        ) : sessions.length === 0 ? (
          <Empty description="还没有历史会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sessions.map((s) => (
              <button
                key={s.session_id}
                type="button"
                onClick={() => void openSession(s.session_id)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${s.session_id === sessionId ? 'rgba(255,107,69,.4)' : 'transparent'}`,
                  background: s.session_id === sessionId ? 'var(--tm-tint)' : '#f7f8fa',
                  borderRadius: 10,
                  padding: '10px 12px',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <div
                  className="tm-clamp-1"
                  style={{ fontSize: 13.5, color: 'var(--tm-text-primary)', lineHeight: 1.5 }}
                >
                  {s.preview || '（空会话）'}
                </div>
                <div style={{ marginTop: 4, fontSize: 11.5, color: TEXT_TERTIARY }}>
                  {formatWhen(s.last_at)} · {s.message_count} 条消息
                </div>
              </button>
            ))}
          </div>
        )}
      </Drawer>

      {/* 我的偏好：个性化记忆（与 RAG 语义记忆分开存/取） */}
      <Drawer
        title="我的偏好"
        placement="right"
        width="86%"
        open={prefOpen}
        onClose={() => setPrefOpen(false)}
        styles={{ body: { padding: 12 } }}
      >
        {!loggedIn ? (
          <div style={{ color: TEXT_SECONDARY, fontSize: 13.5, lineHeight: 1.7 }}>
            登录后可使用「我的偏好」，AI 会据此为你个性化推荐（与规则问答无关）。
          </div>
        ) : prefLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ color: TEXT_TERTIARY, fontSize: 12.5, lineHeight: 1.6 }}>
              这些偏好用于个性化桌游推荐。也可以直接对话，AI 会自动从中提取并积累偏好。
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 6 }}>
                喜欢的分类
              </div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="如 策略、合作、家庭"
                value={pCats}
                onChange={(v) => setPCats(v)}
                options={CATEGORY_OPTIONS.map((c) => ({ label: c, value: c }))}
              />
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 6 }}>
                喜欢的机制
              </div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="如 卡牌驱动、工人放置"
                value={pMechs}
                onChange={(v) => setPMechs(v)}
                options={MECHANIC_OPTIONS.map((m) => ({ label: m, value: m }))}
              />
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 6 }}>
                不喜欢的游戏
              </div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="如 卡坦岛"
                value={pDislikes}
                onChange={(v) => setPDislikes(v)}
              />
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 6 }}>
                  常玩人数
                </div>
                <InputNumber min={1} max={20} value={pPpc} onChange={(v) => setPPpc(v)} placeholder="如 4" />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 6 }}>
                  复杂度上限
                </div>
                <InputNumber
                  min={1}
                  max={5}
                  step={0.1}
                  value={pMaxC}
                  onChange={(v) => setPMaxC(v)}
                  placeholder="1~5"
                />
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_TERTIARY, marginTop: -8 }}>
              复杂度上限需本站已收录各游戏的复杂度数据后才生效（当前数据待补充）。
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tm-text-primary)', marginBottom: 6 }}>
                备注
              </div>
              <Input.TextArea
                rows={2}
                value={pNotes}
                onChange={(e) => setPNotes(e.target.value)}
                placeholder="可选，补充你对玩法的其它偏好"
              />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <Button
                type="primary"
                loading={prefSaving}
                onClick={saveMemory}
                style={{ background: BRAND, borderColor: BRAND }}
              >
                保存偏好
              </Button>
              <Popconfirm title="确定清空全部偏好与交互记录？" onConfirm={clearMemory} okText="清空" cancelText="取消">
                <Button danger>清空</Button>
              </Popconfirm>
            </div>

            <Divider style={{ margin: '4px 0' }}>
              <span style={{ fontSize: 12, color: TEXT_TERTIARY }}>近期交互记录</span>
            </Divider>
            {prefEpisodes.length === 0 ? (
              <Empty description="暂无记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {prefEpisodes.slice().reverse().map((e) => (
                  <div key={e.id} style={{ fontSize: 13, color: 'var(--tm-text-primary)', lineHeight: 1.5 }}>
                    <Tag
                      color={
                        e.kind === 'preference' ? 'green' : e.kind === 'feedback' ? 'orange' : 'blue'
                      }
                      style={{ marginRight: 6 }}
                    >
                      {e.kind === 'preference' ? '偏好' : e.kind === 'feedback' ? '反馈' : '记录'}
                    </Tag>
                    {e.content}
                    <span style={{ marginLeft: 6, fontSize: 11, color: TEXT_TERTIARY }}>
                      {formatWhen(e.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
