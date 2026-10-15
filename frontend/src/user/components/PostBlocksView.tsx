import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { message } from 'antd';
import { CheckOutlined, LineChartOutlined } from '@ant-design/icons';
import client from '../../shared/api/client';
import { useAuthStore } from '../../stores/auth';
import { parsePostBlocks, type MediaItem, type PollData } from '../../shared/postUtils';
import type { PostBlock } from '../../shared/postUtils';

/**
 * 行内富文本：把 [文字](链接) 渲染为可点击链接、#话题# 渲染为话题标签。
 * 用于正文 / 引用块，保证发布页所见即所得。
 */
function renderInline(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\[[^\]]+\]\([^)]+\))|(#[^#\n]+#)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(m[1]);
      if (mm) {
        out.push(
          <a key={k++} href={mm[2]} target="_blank" rel="noopener noreferrer" className="tm-inline-link">
            {mm[1]}
          </a>,
        );
      } else {
        out.push(m[1]);
      }
    } else {
      const topic = m[2].slice(1, -1);
      out.push(
        <span key={k++} className="tm-inline-topic">
          #{topic}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 投票截止时间的友好展示 */
function endLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return '已截止';
  const d = Math.ceil(diff / 86400000);
  if (d <= 1) return '1 天内截止';
  return `${d} 天后截止`;
}

/**
 * 投票块：单选点击即投（可改票），多选勾选后提交；截止后只展示结果。
 * 数据全部来自真实投票记录（post_poll_votes），不做估算。
 */
function PollView({ postId, poll: initial }: { postId: number; poll: PollData }) {
  const { token } = useAuthStore();
  const [poll, setPoll] = useState<PollData>(initial);
  const [picked, setPicked] = useState<number[]>(initial.my_options);
  const [busy, setBusy] = useState(false);

  const totalVotes = poll.options.reduce((s, o) => s + o.vote_count, 0);
  const voted = poll.my_options.length > 0;
  const showResult = voted || poll.expired;

  const submit = async (ids: number[]) => {
    if (!ids.length) return;
    if (!token) {
      message.info('登录后才能参与投票');
      return;
    }
    setBusy(true);
    try {
      const { data } = await client.post<PollData>(`/posts/${postId}/poll/vote`, {
        option_ids: ids,
      });
      setPoll(data);
      setPicked(data.my_options);
      message.success('投票成功');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      message.error(typeof msg === 'string' ? msg : '投票失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--tm-border)',
        borderRadius: 12,
        padding: '16px 18px',
        background: 'var(--tm-tint)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 15.5, color: 'var(--tm-text-primary)' }}>
          {poll.question}
        </span>
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
          {poll.multi ? '多选' : '单选'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginLeft: 'auto' }}>
          {poll.total_voters} 人参与 · {endLabel(poll.end_at)}
        </span>
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {poll.options.map((o) => {
          const pct = totalVotes > 0 ? Math.round((o.vote_count / totalVotes) * 100) : 0;
          const mine = poll.my_options.includes(o.id);
          const pickedNow = picked.includes(o.id);
          return (
            <div
              key={o.id}
              onClick={() => {
                if (poll.expired || busy) return;
                if (poll.multi) {
                  setPicked((prev) =>
                    prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id],
                  );
                } else {
                  void submit([o.id]);
                }
              }}
              className={showResult ? '' : 'tm-press'}
              style={{
                position: 'relative',
                borderRadius: 9,
                border: `1.5px solid ${mine || pickedNow ? 'var(--tm-action)' : 'var(--tm-border)'}`,
                background: '#fff',
                padding: '10px 14px',
                cursor: showResult ? 'default' : 'pointer',
                overflow: 'hidden',
                opacity: busy ? 0.7 : 1,
              }}
            >
              {showResult && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${pct}%`,
                    background: mine ? 'var(--tm-tint-strong)' : '#f2f3f4',
                    transition: 'width .4s var(--tm-ease-out)',
                  }}
                />
              )}
              <div
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  fontSize: 14,
                  color: 'var(--tm-text-primary)',
                }}
              >
                <span
                  style={{
                    width: 17,
                    height: 17,
                    borderRadius: poll.multi ? 5 : '50%',
                    border: `1.5px solid ${mine || pickedNow ? 'var(--tm-action)' : 'var(--tm-border-strong)'}`,
                    background: mine || pickedNow ? 'var(--tm-action)' : '#fff',
                    color: '#fff',
                    fontSize: 10.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {mine || pickedNow ? <CheckOutlined /> : null}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{o.label}</span>
                {showResult && (
                  <span style={{ fontSize: 12.5, color: 'var(--tm-text-secondary)', flexShrink: 0 }}>
                    {o.vote_count} 票 · {pct}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {poll.multi && !showResult && (
        <button
          type="button"
          disabled={picked.length === 0 || busy}
          onClick={() => void submit([...picked])}
          className="tm-press"
          style={{
            marginTop: 12,
            width: '100%',
            border: 'none',
            borderRadius: 999,
            background: picked.length ? 'var(--tm-action)' : '#e5e7eb',
            color: '#fff',
            fontWeight: 700,
            fontSize: 14,
            padding: '10px 0',
            cursor: picked.length ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          投票（已选 {picked.length} 项）
        </button>
      )}
      {poll.expired && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
          投票已截止，以上为最终结果
        </div>
      )}
    </div>
  );
}

/**
 * 帖子正文渲染器：标题 / 列表 / 引用 / 代码 / 分割线 / 表格 / 图片墙 / 视频 / 投票，
 * 详情页与发布页预览共用（预览时传 previewPoll 渲染静态投票卡）。
 */
export default function PostBlocksView({
  content,
  poll = null,
  postId,
  previewPoll = null,
  headerMedia = null,
  headerVideo = null,
  compact = false,
}: {
  content: string;
  /** 详情页传入：真实投票数据（与 ![poll](id) 块对应） */
  poll?: PollData | null;
  /** 有 postId 且已登录才能投票 */
  postId?: number;
  /** 发布页预览：尚未发帖时的静态投票卡 */
  previewPoll?: { question: string; options: string[]; multi: boolean } | null;
  /** 头图区（≤18 张，第一张即封面），渲染为轮播 */
  headerMedia?: MediaItem[] | null;
  headerVideo?: MediaItem | null;
  /** 预览模式下的紧凑排版 */
  compact?: boolean;
}) {
  const blocks = useMemo(() => parsePostBlocks(content), [content]);
  const [viewer, setViewer] = useState<string | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerIdx, setHeaderIdx] = useState(0);
  const fs = (n: number) => (compact ? n - 1.5 : n);
  const gap = compact ? 14 : 20;

  // 头图轮播：切换上一张/下一张/跳到第 n 张（平滑滚动到对应 slide）
  const scrollHeaderTo = (idx: number) => {
    const n = headerMedia?.length ?? 0;
    if (n === 0) return;
    const next = (idx + n) % n;
    setHeaderIdx(next);
    const el = headerRef.current?.children[next] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };
  // 切换帖子时重置到第一张
  useEffect(() => {
    setHeaderIdx(0);
    if (headerRef.current) headerRef.current.scrollLeft = 0;
  }, [headerMedia]);
  // 手动横向滚动时同步高亮当前张
  const onHeaderScroll = () => {
    const el = headerRef.current;
    if (!el || el.clientWidth === 0) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== headerIdx) setHeaderIdx(idx);
  };

  return (
    <>
      {/* 头图轮播：第一张为封面，支持左右箭头 / 圆点切换 */}
      {headerMedia && headerMedia.length > 0 && (
        <div style={{ position: 'relative', marginBottom: gap }}>
          <div
            ref={headerRef}
            onScroll={onHeaderScroll}
            className="tm-header-carousel"
            style={{
              display: 'flex',
              overflowX: 'auto',
              scrollSnapType: 'x mandatory',
              borderRadius: 12,
              scrollbarWidth: 'none',
            }}
          >
            {headerMedia.map((m, i) => (
              <div key={m.id} style={{ position: 'relative', flex: '0 0 100%', scrollSnapAlign: 'start' }}>
                <img
                  src={m.url}
                  alt=""
                  loading={i === 0 ? 'eager' : 'lazy'}
                  onClick={() => setViewer(m.url)}
                  style={{ width: '100%', height: compact ? 200 : 340, objectFit: 'cover', display: 'block', cursor: 'pointer' }}
                />
                <span
                  style={{
                    position: 'absolute',
                    right: 12,
                    bottom: 12,
                    background: 'rgba(0,0,0,.5)',
                    color: '#fff',
                    borderRadius: 999,
                    fontSize: 11.5,
                    padding: '2px 10px',
                  }}
                >
                  {i + 1}/{headerMedia.length}
                  {i === 0 ? ' · 封面' : ''}
                </span>
              </div>
            ))}
          </div>
          {headerMedia.length > 1 && (
            <>
              <button
                type="button"
                className="tm-car-btn tm-car-prev"
                aria-label="上一张"
                onClick={() => scrollHeaderTo(headerIdx - 1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="tm-car-btn tm-car-next"
                aria-label="下一张"
                onClick={() => scrollHeaderTo(headerIdx + 1)}
              >
                ›
              </button>
              <div className="tm-car-dots">
                {headerMedia.map((_, i) => (
                  <span
                    key={i}
                    className={`tm-car-dot${i === headerIdx ? ' is-active' : ''}`}
                    onClick={() => scrollHeaderTo(i)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {headerVideo && (
        <video
          src={`${headerVideo.url}#t=0.1`}
          controls
          playsInline
          preload="metadata"
          style={{ width: '100%', maxHeight: 380, borderRadius: 12, background: '#000', display: 'block', marginBottom: gap }}
        />
      )}
      {blocks.map((b: PostBlock, i: number) => {
        switch (b.type) {
          case 'text':
            return (
              <p
                key={i}
                style={{
                  margin: `0 0 ${gap}px`,
                  fontSize: fs(16.5),
                  lineHeight: 2,
                  color: 'var(--tm-text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {renderInline(b.value)}
              </p>
            );
          case 'heading': {
            const size = b.level === 1 ? 21 : b.level === 2 ? 18.5 : 16.5;
            return (
              <h3
                key={i}
                style={{
                  margin: `${i === 0 ? 0 : gap + 4}px 0 ${gap - 6}px`,
                  fontSize: fs(size),
                  fontWeight: 800,
                  lineHeight: 1.5,
                  color: 'var(--tm-text-primary)',
                }}
              >
                {b.value}
              </h3>
            );
          }
          case 'list':
            return (
              <ul
                key={i}
                style={{
                  margin: `0 0 ${gap}px`,
                  paddingInlineStart: 22,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {b.items.map((it, j) => (
                  <li
                    key={j}
                    style={{
                      fontSize: fs(16),
                      lineHeight: 1.9,
                      color: 'var(--tm-text-primary)',
                      listStyle: b.ordered ? 'decimal' : 'disc',
                    }}
                  >
                    {it}
                  </li>
                ))}
              </ul>
            );
          case 'quote':
            return (
              <blockquote
                key={i}
                style={{
                  margin: `0 0 ${gap}px`,
                  padding: '10px 16px',
                  borderLeft: '3px solid var(--tm-action)',
                  background: 'var(--tm-tint)',
                  borderRadius: '0 10px 10px 0',
                  fontSize: fs(15),
                  lineHeight: 1.9,
                  color: 'var(--tm-text-secondary)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {renderInline(b.value)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={i}
                style={{
                  margin: `0 0 ${gap}px`,
                  padding: '14px 16px',
                  background: '#f6f8fa',
                  border: '1px solid var(--tm-border)',
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.7,
                  overflowX: 'auto',
                  fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", monospace',
                  color: '#24292f',
                }}
              >
                {b.value}
              </pre>
            );
          case 'divider':
            return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--tm-border)', margin: `${gap - 4}px 0` }} />;
          case 'table':
            return (
              <div
                key={i}
                style={{ margin: `0 0 ${gap}px`, overflowX: 'auto', border: '1px solid var(--tm-border)', borderRadius: 10 }}
              >
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: fs(14) }}>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            style={{
                              border: '1px solid var(--tm-border)',
                              padding: '8px 12px',
                              color: 'var(--tm-text-primary)',
                              background: r === 0 ? 'var(--tm-tint)' : '#fff',
                              fontWeight: r === 0 ? 700 : 400,
                              lineHeight: 1.6,
                              minWidth: 80,
                            }}
                          >
                            {cell || ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'gallery': {
            const cols = b.urls.length === 1 ? 1 : b.urls.length === 2 ? 2 : 3;
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gap: 6,
                  margin: `0 0 ${gap}px`,
                }}
              >
                {b.urls.map((u) => (
                  <div
                    key={u}
                    onClick={() => setViewer(u)}
                    className="tm-press"
                    style={{
                      aspectRatio: b.urls.length === 1 ? '16 / 9' : '1 / 1',
                      borderRadius: 12,
                      overflow: 'hidden',
                      background: '#f2f3f4',
                      cursor: 'pointer',
                    }}
                  >
                    <img
                      src={u}
                      alt=""
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </div>
                ))}
              </div>
            );
          }
          case 'video':
            return (
              <div key={i} style={{ margin: `0 0 ${gap}px` }}>
                <video
                  src={`${b.url}#t=0.1`}
                  controls
                  playsInline
                  preload="metadata"
                  style={{
                    width: '100%',
                    maxHeight: 460,
                    background: '#000',
                    borderRadius: 12,
                    display: 'block',
                  }}
                />
              </div>
            );
          case 'poll':
            if (previewPoll) {
              return (
                <div
                  key={i}
                  style={{
                    border: '1.5px dashed var(--tm-border-strong)',
                    borderRadius: 12,
                    padding: '14px 16px',
                    background: 'var(--tm-tint)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 800, fontSize: 15 }}>{previewPoll.question || '投票标题'}</span>
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
                      {previewPoll.multi ? '多选' : '单选'}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--tm-text-tertiary)' }}>
                      <LineChartOutlined /> 预览
                    </span>
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {previewPoll.options.map((o, j) => (
                      <div
                        key={j}
                        style={{
                          border: '1px solid var(--tm-border)',
                          background: '#fff',
                          borderRadius: 9,
                          padding: '9px 13px',
                          fontSize: 13.5,
                          color: o ? 'var(--tm-text-primary)' : 'var(--tm-text-tertiary)',
                        }}
                      >
                        {o || `选项 ${j + 1}`}
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            if (poll && postId) {
              return <PollView key={i} postId={postId} poll={poll} />;
            }
            return null;
          default:
            return null;
        }
      })}

      {viewer &&
        createPortal(
          <div
            onClick={() => setViewer(null)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 200,
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
    </>
  );
}
