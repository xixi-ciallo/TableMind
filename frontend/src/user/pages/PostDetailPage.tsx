import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, message } from 'antd';
import {
  CommentOutlined,
  DislikeFilled,
  DislikeOutlined,
  LeftOutlined,
  LikeFilled,
  LikeOutlined,
  SmileOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { useIsMobile } from '../../shared/useIsMobile';
import client from '../../shared/api/client';
import { useAuthStore } from '../../stores/auth';
import { timeAgo } from '../../shared/postUtils';
import PostBlocksView from '../components/PostBlocksView';
import type { CommentItem, PostItem } from '../../shared/postUtils';

/** 头像：有真实头像 URL 用图，否则首字母占位 */
function AvatarView({ name, avatar, size }: { name: string; avatar?: string | null; size: number }) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#f0f1f3',
        color: 'var(--tm-text-secondary)',
        fontWeight: 700,
        fontSize: Math.max(12, size * 0.4),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

/** 圆形图标小按钮（顶部作者栏右侧） */
function CircleBtn({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="tm-press"
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        border: '1px solid var(--tm-border)',
        background: active ? 'var(--tm-tint-strong)' : '#fff',
        color: active ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
        fontSize: 15,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}


export default function PostDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const isLoggedIn = Boolean(token);

  const [post, setPost] = useState<PostItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commenting, setCommenting] = useState(false);
  /** 正在回复谁（@昵称 + parent_id） */
  const [replyTo, setReplyTo] = useState<{ id: number; name: string } | null>(null);
  /** 只看作者 / 排序（最新、最热） */
  const [onlyAuthor, setOnlyAuthor] = useState(false);
  const [sortMode, setSortMode] = useState<'new' | 'hot'>('new');
  /** 已展开全部回复的根评论 id */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  /** 防止 React StrictMode / 依赖变化导致重复请求重复计浏览量 */
  const viewCounted = useRef<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const commentsRef = useRef<HTMLDivElement | null>(null);

  const loadPost = useCallback(async () => {
    if (!id) return;
    const pid = Number(id);
    if (viewCounted.current === pid) return;
    viewCounted.current = pid;
    try {
      const { data } = await client.get<PostItem>(`/posts/${pid}`);
      setPost(data);
    } catch {
      setNotFound(true);
    }
  }, [id]);

  const loadComments = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await client.get<CommentItem[]>(`/posts/${id}/comments`);
      setComments(Array.isArray(data) ? data : []);
    } catch {
      setComments([]);
    }
  }, [id]);

  useEffect(() => {
    viewCounted.current = null;
    setPost(null);
    setNotFound(false);
    loadPost();
    loadComments();
  }, [loadPost, loadComments]);

  const toggleLike = async () => {
    if (!post) return;
    if (!isLoggedIn) {
      message.info('登录后才能点赞');
      return;
    }
    try {
      const { data } = await client.post<{ liked: boolean; like_count: number }>(`/posts/${post.id}/like`);
      setPost({ ...post, liked: data.liked, like_count: data.like_count });
    } catch {
      message.error('操作失败，请重试');
    }
  };

  const toggleMark = async () => {
    if (!post) return;
    if (!isLoggedIn) {
      message.info('登录后才能收藏');
      return;
    }
    try {
      const { data } = await client.post<{ marked: boolean; mark_count: number }>(`/posts/${post.id}/mark`);
      setPost({ ...post, marked: data.marked, mark_count: data.mark_count });
      message.success(data.marked ? '已收藏' : '已取消收藏');
    } catch {
      message.error('操作失败，请重试');
    }
  };

  const focusComposer = (target?: { id: number; name: string }) => {
    if (!isLoggedIn) {
      message.info('登录后才能回复');
      return;
    }
    setReplyTo(target ?? null);
    composerRef.current?.focus();
  };

  const toggleCommentVote = async (c: CommentItem, value: 1 | -1) => {
    if (!post) return;
    if (!isLoggedIn) {
      message.info('登录后才能操作');
      return;
    }
    try {
      const { data } = await client.post<{
        like_count: number;
        dislike_count: number;
        liked: boolean;
        disliked: boolean;
      }>(`/posts/${post.id}/comments/${c.id}/like`, { value });
      setComments((prev) =>
        prev.map((x) =>
          x.id === c.id
            ? { ...x, like_count: data.like_count, dislike_count: data.dislike_count, liked: data.liked, disliked: data.disliked }
            : x,
        ),
      );
    } catch {
      message.error('操作失败，请重试');
    }
  };

  const submitComment = async () => {
    if (!post) return;
    if (!isLoggedIn) {
      message.info('登录后才能回复');
      return;
    }
    let text = commentText.trim();
    if (!text) {
      message.warning('回复内容不能为空');
      return;
    }
    const parentId = replyTo?.id ?? null;
    // 回复时把 @昵称 写进正文（真实数据，而非仅展示层拼装）
    if (replyTo && !text.startsWith(`@${replyTo.name}`)) text = `@${replyTo.name} ${text}`;
    setCommenting(true);
    try {
      const { data } = await client.post<CommentItem>(`/posts/${post.id}/comments`, {
        content: text,
        parent_id: parentId,
      });
      setComments((prev) => [...prev, data]);
      setCommentText('');
      setReplyTo(null);
      setPost({ ...post, comment_count: post.comment_count + 1 });
      message.success('回复已发布');
    } catch {
      message.error('发布失败，请重试');
    } finally {
      setCommenting(false);
    }
  };

  /* ── 评论树：根评论（只看作者过滤 + 排序）与每条根下的回复组 ── */
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);

  const rootComments = useMemo(() => {
    let list = comments.filter((c) => c.parent_id == null);
    if (onlyAuthor && post) list = list.filter((c) => c.user_id === post.user_id);
    if (sortMode === 'hot') {
      list = [...list].sort(
        (a, b) => b.like_count - b.dislike_count - (a.like_count - a.dislike_count),
      );
    } else {
      list = [...list].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    return list;
  }, [comments, onlyAuthor, sortMode, post]);

  /** 回复归组到根评论（回复的回复也挂到同一根下） */
  const repliesOf = useMemo(() => {
    const map = new Map<number, CommentItem[]>();
    for (const c of comments) {
      if (c.parent_id == null) continue;
      let root = c.parent_id;
      for (let guard = 0; guard < 32; guard += 1) {
        const p = byId.get(root);
        if (!p || p.parent_id == null) break;
        root = p.parent_id;
      }
      if (!map.has(root)) map.set(root, []);
      map.get(root)!.push(c);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    return map;
  }, [comments, byId]);

  const toggleExpand = (rootId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  if (notFound) {
    return (
      <div style={{ maxWidth: 780, margin: '0 auto', width: '100%', textAlign: 'center', padding: '80px 0' }}>
        <div style={{ fontSize: 16, color: 'var(--tm-text-secondary)', marginBottom: 16 }}>
          帖子不存在或已被删除
        </div>
        <Button onClick={() => navigate('/community')}>返回社区</Button>
      </div>
    );
  }

  if (!post) {
    return (
      <div style={{ maxWidth: 780, margin: '0 auto', width: '100%', textAlign: 'center', padding: '80px 0', color: 'var(--tm-text-tertiary)' }}>
        加载中…
      </div>
    );
  }

  /** 单条评论（含操作行） */
  const CommentBody = ({ c, nested }: { c: CommentItem; nested?: boolean }) => (
    <div style={{ display: 'flex', gap: 10, flex: 1, minWidth: 0 }}>
      <AvatarView name={c.author_name} avatar={c.author_avatar} size={nested ? 28 : 34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--tm-text-primary)' }}>{c.author_name}</span>
          {c.author_role === 'admin' && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: '#fff',
                background: 'var(--tm-action)',
                borderRadius: 5,
                padding: '1px 6px',
              }}
            >
              官方
            </span>
          )}
          <span style={{ fontSize: 11.5, color: 'var(--tm-text-tertiary)' }}>{timeAgo(c.created_at)}</span>
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.8, marginTop: 3, whiteSpace: 'pre-wrap', color: 'var(--tm-text-primary)' }}>
          {c.content}
        </div>
        {/* 操作行：赞 / 踩 / 回复 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 7 }}>
          <button
            type="button"
            onClick={() => toggleCommentVote(c, 1)}
            className="tm-press"
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 12.5, color: c.liked ? 'var(--tm-action)' : 'var(--tm-text-tertiary)', fontWeight: c.liked ? 700 : 500,
            }}
          >
            {c.liked ? <LikeFilled /> : <LikeOutlined />} {c.like_count || ''}
          </button>
          <button
            type="button"
            onClick={() => toggleCommentVote(c, -1)}
            className="tm-press"
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 12.5, color: c.disliked ? 'var(--tm-action)' : 'var(--tm-text-tertiary)', fontWeight: c.disliked ? 700 : 500,
            }}
          >
            {c.disliked ? <DislikeFilled /> : <DislikeOutlined />} {c.dislike_count || ''}
          </button>
          <button
            type="button"
            onClick={() => focusComposer({ id: c.id, name: c.author_name })}
            className="tm-press"
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--tm-text-tertiary)',
            }}
          >
            <CommentOutlined /> 回复
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="tm-page-enter"
      style={{
        maxWidth: 780,
        margin: '0 auto',
        width: '100%',
        padding: isMobile ? '8px 16px 120px' : '8px 0 130px',
      }}
    >
      {/* 顶部作者栏：返回 + 头像 + 昵称 + 收藏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0 16px' }}>
        <CircleBtn title="返回" onClick={() => navigate('/community')}>
          <LeftOutlined />
        </CircleBtn>
        <AvatarView name={post.author_name} avatar={post.author_avatar} size={40} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--tm-text-primary)' }}>{post.author_name}</span>
            {post.is_official && (
              <span
                style={{
                  fontSize: 11, fontWeight: 700, color: '#fff', background: 'var(--tm-action)',
                  borderRadius: 5, padding: '1px 6px',
                }}
              >
                官方
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tm-text-tertiary)', marginTop: 1 }}>
            {timeAgo(post.created_at)} · {post.view_count} 浏览 · {post.is_official ? '官方公告' : '玩家讨论'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <CircleBtn title={post.marked ? '取消收藏' : '收藏'} active={post.marked} onClick={toggleMark}>
            {post.marked ? <StarFilled /> : <StarOutlined />}
          </CircleBtn>
        </div>
      </div>

      {/* 帖子正文：作为一条内容流呈现，不再用「文档卡片」式的高对比描边 */}
      <article
        style={{
          background: '#fff',
          borderRadius: 14,
          padding: isMobile ? '20px 16px 6px' : '28px 34px 10px',
        }}
      >
        <h1
          style={{
            fontSize: isMobile ? 21 : 26,
            fontWeight: 800,
            margin: '0 0 14px',
            lineHeight: 1.35,
            letterSpacing: -0.2,
            color: 'var(--tm-text-primary)',
          }}
        >
          {post.title}
        </h1>
        {post.game_id && post.game_name && (
          <span
            onClick={() => navigate(`/games/${post.game_id}`)}
            className="tm-press"
            style={{
              display: 'inline-block',
              background: 'var(--tm-tint)',
              color: 'var(--tm-action)',
              borderRadius: 999,
              padding: '5px 13px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              marginBottom: 18,
            }}
          >
            {post.game_name}
          </span>
        )}
        <PostBlocksView
          content={post.content}
          poll={post.poll ?? null}
          postId={isLoggedIn && post ? post.id : undefined}
          headerMedia={post.header_media ?? null}
          headerVideo={post.header_video ?? null}
        />
      </article>

      {/* 相关桌游（评论区上方，点击进桌游详情） */}
      {post.game_id && post.game_name && (
        <section style={{ marginTop: 18 }}>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10, color: 'var(--tm-text-primary)' }}>
            相关桌游
          </div>
          <div
            onClick={() => navigate(`/games/${post.game_id}`)}
            className="tm-press"
            style={{
              position: 'relative',
              borderRadius: 12,
              overflow: 'hidden',
              cursor: 'pointer',
              minHeight: 104,
              background: 'linear-gradient(135deg, #2b2f36, #454b55)',
            }}
          >
            {post.game_cover && (
              <img
                src={post.game_cover}
                alt=""
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'cover', filter: 'brightness(.42) saturate(.85)',
                }}
              />
            )}
            <div
              style={{
                position: 'relative', display: 'flex', alignItems: 'center',
                gap: 16, padding: '12px 18px', minHeight: 104,
              }}
            >
              {post.game_cover ? (
                <img
                  src={post.game_cover}
                  alt={post.game_name}
                  style={{ width: 62, height: 84, borderRadius: 6, objectFit: 'cover', flexShrink: 0, boxShadow: '0 4px 14px rgba(0,0,0,.4)' }}
                />
              ) : null}
              <div style={{ minWidth: 0 }}>
                <div style={{ color: '#fff', fontSize: 17, fontWeight: 800 }}>{post.game_name}</div>
                {post.game_name_en && (
                  <div style={{ color: 'rgba(255,255,255,.78)', fontSize: 13, marginTop: 3 }}>{post.game_name_en}</div>
                )}
                {(post.game_year || post.game_category) && (
                  <div style={{ color: 'rgba(255,255,255,.6)', fontSize: 12.5, marginTop: 4 }}>
                    {[post.game_year, post.game_category].filter(Boolean).join(' / ')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 评论区 */}
      <div ref={commentsRef}>
        <section
          style={{
            background: '#fff',
            border: '1px solid var(--tm-border)',
            borderRadius: 14,
            padding: isMobile ? '18px 16px' : '22px 30px',
            marginTop: 18,
          }}
        >
          {/* 头部：评论数 + 只看作者 + 排序 */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--tm-text-primary)' }}>
              评论 {comments.length}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={() => setOnlyAuthor((v) => !v)}
                className="tm-press"
                style={{
                  border: `1px solid ${onlyAuthor ? 'var(--tm-action)' : 'var(--tm-border)'}`,
                  background: onlyAuthor ? 'var(--tm-tint-strong)' : '#fff',
                  color: onlyAuthor ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
                  borderRadius: 999,
                  padding: '5px 14px',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                只看作者
              </button>
              <div
                style={{
                  display: 'inline-flex',
                  border: '1px solid var(--tm-border)',
                  borderRadius: 999,
                  overflow: 'hidden',
                }}
              >
                {(['new', 'hot'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSortMode(m)}
                    className="tm-press"
                    style={{
                      border: 'none',
                      background: sortMode === m ? 'var(--tm-tint-strong)' : '#fff',
                      color: sortMode === m ? 'var(--tm-action)' : 'var(--tm-text-secondary)',
                      padding: '5px 14px',
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {m === 'new' ? '最新' : '最热'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 评论输入框：头像 + 胶囊输入 + @ / 表情 / 发送 */}
          <div style={{ background: '#f5f6f7', borderRadius: 16, padding: '12px 14px', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {isLoggedIn ? (
                <AvatarView name={user?.username ?? '我'} avatar={user?.avatar} size={34} />
              ) : null}
              <div
                style={{
                  flex: 1, background: '#fff', borderRadius: 999,
                  padding: '7px 16px', display: 'flex', alignItems: 'center',
                }}
              >
                <Input.TextArea
                  ref={composerRef as never}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault();
                      submitComment();
                    }
                  }}
                  placeholder={
                    !isLoggedIn
                      ? '登录后即可评论'
                      : replyTo
                        ? `回复 @${replyTo.name}：`
                        : '友善交流，理性讨论'
                  }
                  disabled={!isLoggedIn}
                  maxLength={500}
                  style={{ border: 'none', boxShadow: 'none', background: 'transparent', fontSize: 13.5 }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 9, paddingLeft: 44 }}>
              <button
                type="button"
                title="插入 @"
                onClick={() => setCommentText((t) => `${t}@`)}
                className="tm-press"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--tm-text-tertiary)', fontSize: 16, fontWeight: 800, fontFamily: 'inherit', lineHeight: 1 }}
              >
                @
              </button>
              <button
                type="button"
                title="插入表情"
                onClick={() => setCommentText((t) => `${t}[微笑]`)}
                className="tm-press"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--tm-text-tertiary)', fontSize: 16, fontFamily: 'inherit' }}
              >
                <SmileOutlined />
              </button>
              <Button
                type="primary"
                loading={commenting}
                onClick={submitComment}
                disabled={!isLoggedIn}
                style={{ marginLeft: 'auto', borderRadius: 999, paddingInline: 22 }}
              >
                发送
              </Button>
            </div>
          </div>

          {/* 评论列表（根评论 + 折叠回复） */}
          {rootComments.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--tm-text-tertiary)', paddingBottom: 10 }}>
              {onlyAuthor ? '作者还没有回复过' : '还没有评论，来抢沙发'}
            </div>
          )}
          {rootComments.map((rc) => {
            const replies = repliesOf.get(rc.id) ?? [];
            const shown = expanded.has(rc.id) ? replies : replies.slice(0, 2);
            const hidden = replies.length - shown.length;
            return (
              <div key={rc.id} style={{ padding: '14px 0', borderBottom: '1px solid #f1f2f4' }}>
                <div style={{ display: 'flex' }}>
                  <CommentBody c={rc} />
                </div>
                {replies.length > 0 && (
                  <div style={{ marginTop: 10, paddingLeft: isMobile ? 30 : 44, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {shown.map((r) => (
                      <div key={r.id} style={{ display: 'flex' }}>
                        <CommentBody c={r} nested />
                      </div>
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(rc.id)}
                        className="tm-press"
                        style={{
                          border: 'none', background: '#f5f6f7', cursor: 'pointer', fontFamily: 'inherit',
                          alignSelf: 'flex-start', borderRadius: 999, padding: '6px 14px',
                          fontSize: 12.5, fontWeight: 600, color: 'var(--tm-text-secondary)',
                        }}
                      >
                        展开剩余 {hidden} 条回复 &gt;
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      {/* 底部固定操作栏：点赞 / 收藏 / 评论
          （portal 到 body：外层 tm-page-enter 的 transform 会劫持 fixed 定位上下文） */}
      {createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: isMobile ? 18 : 26,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 95,
            background: '#fff',
            borderRadius: 999,
            boxShadow: '0 10px 34px rgba(15,23,42,.18)',
            border: '1px solid var(--tm-border)',
            padding: '11px 30px',
            display: 'flex',
            alignItems: 'center',
            gap: isMobile ? 26 : 40,
          }}
        >
        {([
          {
            key: 'like',
            active: post.liked,
            icon: post.liked ? <LikeFilled /> : <LikeOutlined />,
            count: post.like_count,
            onClick: toggleLike,
          },
          {
            key: 'mark',
            active: Boolean(post.marked),
            icon: post.marked ? <StarFilled /> : <StarOutlined />,
            count: post.mark_count ?? 0,
            onClick: toggleMark,
          },
          {
            key: 'comment',
            active: false,
            icon: <CommentOutlined />,
            count: post.comment_count,
            onClick: () => {
              commentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              focusComposer();
            },
          },
        ] as const).map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            className="tm-press"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 14.5,
              fontWeight: 700,
              color: a.active ? 'var(--tm-action)' : 'var(--tm-text-primary)',
            }}
          >
            <span style={{ fontSize: 18 }}>{a.icon}</span>
            {a.count || ''}
          </button>
        ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
