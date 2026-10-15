"""社区帖子：列表 / 详情 / 发帖 / 评论 / 点赞 / 侧栏统计。

所有计数（点赞数、评论数）都来自数据库真实聚合，不做任何估算或写死。
"""
import os
import uuid
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, get_optional_user
from app.models.board_game import BoardGame
from app.models.comment import Comment, CommentLike
from app.models.post import Post, PostLike, PostMark
from app.models.post_media import PostMedia
from app.models.post_poll import PostPoll, PostPollOption, PostPollVote
from app.models.search_log import SearchLog
from app.models.user import User
from app.schemas.post import (
    CommentCreate,
    CommentLikeToggle,
    CommentOut,
    PollOut,
    PollVoteIn,
    PostCreate,
    PostMarkOut,
    PostMediaOut,
    PostOut,
    PostStats,
    PostUpdate,
)

router = APIRouter()

# 帖子附件落盘：backend/uploads/posts/<user_id>/<uuid>.<ext>
MEDIA_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "uploads",
    "posts",
)
MAX_MEDIA = 9  # 正文内嵌附件上限
MAX_HEADER_IMAGES = 18  # 头图上限（与 1 个视频互斥）
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 单张图片 8MB
MAX_VIDEO_BYTES = 80 * 1024 * 1024  # 单个视频 80MB
ALLOWED_IMAGE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
ALLOWED_VIDEO = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}


async def _counts(db: AsyncSession, post_ids: list[int]) -> dict[int, tuple[int, int]]:
    """批量取点赞数与评论数，避免 N+1。"""
    if not post_ids:
        return {}
    like_rows = (
        await db.execute(
            select(PostLike.post_id, func.count(PostLike.id))
            .where(PostLike.post_id.in_(post_ids))
            .group_by(PostLike.post_id)
        )
    ).all()
    cmt_rows = (
        await db.execute(
            select(Comment.post_id, func.count(Comment.id))
            .where(Comment.post_id.in_(post_ids))
            .group_by(Comment.post_id)
        )
    ).all()
    likes = {pid: int(c) for pid, c in like_rows}
    cmts = {pid: int(c) for pid, c in cmt_rows}
    return {pid: (likes.get(pid, 0), cmts.get(pid, 0)) for pid in post_ids}


async def _liked_ids(db: AsyncSession, user_id: int | None, post_ids: list[int]) -> set[int]:
    if not user_id or not post_ids:
        return set()
    rows = (
        await db.execute(
            select(PostLike.post_id).where(
                PostLike.user_id == user_id, PostLike.post_id.in_(post_ids)
            )
        )
    ).scalars().all()
    return set(rows)


async def _media_map(db: AsyncSession, post_ids: list[int]) -> dict[int, list[PostMedia]]:
    """批量取帖子附件（图片 / 视频），按 sort_order 排序。"""
    if not post_ids:
        return {}
    rows = (
        await db.execute(
            select(PostMedia)
            .where(PostMedia.post_id.in_(post_ids))
            .order_by(PostMedia.sort_order.asc(), PostMedia.id.asc())
        )
    ).scalars().all()
    out: dict[int, list[PostMedia]] = {pid: [] for pid in post_ids}
    for m in rows:
        out.setdefault(m.post_id, []).append(m)
    return out


async def _poll_out(
    db: AsyncSession, post_id: int, user_id: int | None
) -> PollOut | None:
    """取帖子的投票详情（选项票数、当前用户已投选项、是否已截止）。"""
    poll = (
        await db.execute(select(PostPoll).where(PostPoll.post_id == post_id))
    ).scalar_one_or_none()
    if not poll:
        return None
    options = (
        await db.execute(
            select(PostPollOption)
            .where(PostPollOption.poll_id == poll.id)
            .order_by(PostPollOption.sort_order.asc(), PostPollOption.id.asc())
        )
    ).scalars().all()
    count_rows = (
        await db.execute(
            select(PostPollVote.option_id, func.count(PostPollVote.id))
            .where(PostPollVote.poll_id == poll.id)
            .group_by(PostPollVote.option_id)
        )
    ).all()
    counts = {oid: int(c) for oid, c in count_rows}
    total_voters = int(
        (
            await db.execute(
                select(func.count(func.distinct(PostPollVote.user_id))).where(
                    PostPollVote.poll_id == poll.id
                )
            )
        ).scalar()
        or 0
    )
    my_options: list[int] = []
    if user_id:
        my_options = list(
            (
                await db.execute(
                    select(PostPollVote.option_id).where(
                        PostPollVote.poll_id == poll.id, PostPollVote.user_id == user_id
                    )
                )
            ).scalars().all()
        )
    return PollOut(
        id=poll.id,
        question=poll.question,
        multi=bool(poll.multi),
        end_at=poll.end_at,
        options=[
            {"id": o.id, "label": o.label, "vote_count": counts.get(o.id, 0)} for o in options
        ],
        total_voters=total_voters,
        my_options=my_options,
        expired=poll.end_at <= datetime.utcnow(),
    )


def _cover_of(media: list[PostMedia]) -> tuple[str | None, str | None]:
    """列表缩略图：头图区第一张图优先（无图才用头图视频），都没有则回退正文内嵌媒体。"""
    header = [m for m in media if m.slot == "header"]
    imgs = [m.url for m in header if m.kind == "image"]
    vids = [m.url for m in header if m.kind == "video"]
    inline = [m for m in media if m.slot == "inline"]
    cover_image = imgs[0] if imgs else next((m.url for m in inline if m.kind == "image"), None)
    cover_video = None
    if not cover_image:
        cover_video = vids[0] if vids else next((m.url for m in inline if m.kind == "video"), None)
    return cover_image, cover_video


async def _to_out(
    db: AsyncSession,
    post: Post,
    author: User | None,
    game_name: str | None,
    like_count: int,
    comment_count: int,
    liked: bool,
    game_cover: str | None = None,
    *,
    game_name_en: str | None = None,
    game_year: int | None = None,
    game_category: str | None = None,
    marked: bool = False,
    mark_count: int = 0,
    media: list[PostMedia] | None = None,
    poll: PollOut | None = None,
) -> PostOut:
    media_list = media or []
    cover_image, cover_video = _cover_of(media_list)
    header = sorted([m for m in media_list if m.slot == "header"], key=lambda m: (m.sort_order, m.id))
    inline = sorted([m for m in media_list if m.slot != "header"], key=lambda m: (m.sort_order, m.id))
    header_video = next((m for m in header if m.kind == "video"), None)
    return PostOut(
        id=post.id,
        user_id=post.user_id,
        game_id=post.game_id,
        title=post.title,
        content=post.content,
        created_at=post.created_at,
        is_pinned=bool(post.is_pinned),
        view_count=int(post.view_count or 0),
        game_cover=game_cover,
        author_name=author.username if author else "已注销用户",
        author_role=author.role if author else "user",
        author_avatar=(author.avatar if author else None),
        is_official=bool(author and author.role == "admin"),
        game_name=game_name,
        game_name_en=game_name_en,
        game_year=game_year,
        game_category=game_category,
        like_count=like_count,
        comment_count=comment_count,
        liked=liked,
        marked=marked,
        mark_count=mark_count,
        media=[PostMediaOut.model_validate(m) for m in inline],
        header_media=[PostMediaOut.model_validate(m) for m in header if m.kind == "image"],
        header_video=PostMediaOut.model_validate(header_video) if header_video else None,
        cover_image=cover_image,
        cover_video=cover_video,
        poll=poll,
    )


@router.get("", response_model=dict)
async def list_posts(
    sort: str = Query("new", pattern="^(new|hot)$"),
    kind: str = Query("all", pattern="^(all|official|discussion)$"),
    game_id: int | None = None,
    mine: bool = False,
    q: str | None = Query(None, description="关键词（标题 / 正文，模糊匹配）"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    """帖子列表：官方公告置顶，其余按最新 / 最热排序。

    official=作者为管理员的帖；discussion=普通玩家帖；q=按标题/正文模糊搜索。
    """
    needs_user_join = kind in ("official", "discussion")
    stmt = select(Post)
    count_stmt = select(func.count(Post.id))
    if game_id:
        stmt = stmt.where(Post.game_id == game_id)
        count_stmt = count_stmt.where(Post.game_id == game_id)
    if mine:
        # 个人中心「我的帖子」：只取当前登录用户自己发布的帖子
        if not current_user:
            raise HTTPException(status_code=401, detail="请先登录")
        stmt = stmt.where(Post.user_id == current_user.id)
        count_stmt = count_stmt.where(Post.user_id == current_user.id)
    if q:
        kw = f"%{q.strip()}%"
        stmt = stmt.where(or_(Post.title.ilike(kw), Post.content.ilike(kw)))
        count_stmt = count_stmt.where(or_(Post.title.ilike(kw), Post.content.ilike(kw)))
    if needs_user_join:
        role_cond = User.role == "admin" if kind == "official" else User.role != "admin"
        stmt = stmt.join(User, User.id == Post.user_id).where(role_cond)
        count_stmt = count_stmt.join(User, User.id == Post.user_id).where(role_cond)

    if sort == "hot":
        # 热度 = 点赞数 + 评论数，用子查询排序，仍在 SQL 层完成
        like_sq = (
            select(PostLike.post_id, func.count(PostLike.id).label("lc"))
            .group_by(PostLike.post_id)
            .subquery()
        )
        cmt_sq = (
            select(Comment.post_id, func.count(Comment.id).label("cc"))
            .group_by(Comment.post_id)
            .subquery()
        )
        heat = func.coalesce(like_sq.c.lc, 0) + func.coalesce(cmt_sq.c.cc, 0)
        stmt = (
            stmt.outerjoin(like_sq, like_sq.c.post_id == Post.id)
            .outerjoin(cmt_sq, cmt_sq.c.post_id == Post.id)
            .order_by(Post.is_pinned.desc(), heat.desc(), Post.created_at.desc())
        )
    else:
        stmt = stmt.order_by(Post.is_pinned.desc(), Post.created_at.desc())

    total = (await db.execute(count_stmt)).scalar() or 0
    rows = (
        await db.execute(stmt.offset((page - 1) * page_size).limit(page_size))
    ).scalars().unique().all()

    posts = list(rows)
    ids = [p.id for p in posts]
    counts = await _counts(db, ids)
    liked = await _liked_ids(db, current_user.id if current_user else None, ids)
    game_info: dict[int, tuple[str, str | None]] = {}
    gids = [p.game_id for p in posts if p.game_id]
    if gids:
        g_rows = (
            await db.execute(
                select(BoardGame.id, BoardGame.name, BoardGame.cover_image).where(
                    BoardGame.id.in_(gids)
                )
            )
        ).all()
        game_info = {gid: (name, cover) for gid, name, cover in g_rows}
    media_map = await _media_map(db, ids)

    out = [
        await _to_out(
            db,
            p,
            p.user,
            game_info[p.game_id][0] if p.game_id in game_info else None,
            *counts.get(p.id, (0, 0)),
            p.id in liked,
            game_info[p.game_id][1] if p.game_id in game_info else None,
            media=media_map.get(p.id, []),
        )
        for p in posts
    ]
    return {"rows": out, "total": int(total), "page": page, "page_size": page_size}


@router.get("/stats", response_model=PostStats)
async def post_stats(db: AsyncSession = Depends(get_db)):
    """侧栏真实数据：热门话题（按帖子浏览量排序，展示帖子标题）+ 热门搜索（真实搜索记录）。"""
    topic_rows = (
        await db.execute(
            select(
                Post.id,
                Post.title,
                func.coalesce(Post.view_count, 0).label("vw"),
            )
            .order_by(func.coalesce(Post.view_count, 0).desc(), Post.id.asc())
            .limit(8)
        )
    ).all()
    search_rows = (
        await db.execute(
            select(SearchLog.term, func.count(SearchLog.id).label("cnt"))
            .group_by(SearchLog.term)
            .order_by(func.count(SearchLog.id).desc(), SearchLog.term.asc())
            .limit(8)
        )
    ).all()
    return PostStats(
        topics=[{"id": pid, "title": title, "view_count": int(vw)} for pid, title, vw in topic_rows],
        hot_searches=[{"term": term, "count": int(cnt)} for term, cnt in search_rows],
    )


async def _game_info(db: AsyncSession, game_id: int | None) -> tuple[str | None, str | None]:
    """取关联桌游的名称与封面，不存在则 (None, None)。"""
    if not game_id:
        return None, None
    row = (
        await db.execute(
            select(BoardGame.name, BoardGame.cover_image).where(BoardGame.id == game_id)
        )
    ).first()
    return (row[0], row[1]) if row else (None, None)


@router.post("", response_model=PostOut)
async def create_post(
    data: PostCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """发帖：需登录；关联桌游可选，但必须真实存在于库内。"""
    if data.game_id is not None:
        exists = (
            await db.execute(select(BoardGame.id).where(BoardGame.id == data.game_id))
        ).scalar_one_or_none()
        if not exists:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "关联的桌游不存在")

    post = Post(
        user_id=current_user.id,
        game_id=data.game_id,
        title=data.title,
        content=data.content,
        is_pinned=bool(current_user.role == "admin" and data.title.startswith("【公告】")),
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # 绑定发布页已上传的附件（只认自己的、尚未绑定帖子的），头图与内嵌分开按传入顺序排
    media: list[PostMedia] = []
    for ids, slot in ((data.header_media_ids, "header"), (data.media_ids, "inline")):
        if not ids:
            continue
        rows = (
            await db.execute(
                select(PostMedia)
                .where(
                    PostMedia.id.in_(ids),
                    PostMedia.user_id == current_user.id,
                    PostMedia.post_id.is_(None),
                )
                .order_by(PostMedia.id.asc())
            )
        ).scalars().all()
        order = {mid: i for i, mid in enumerate(ids)}
        rows = sorted(rows, key=lambda m: order.get(m.id, 0))
        for i, m in enumerate(rows):
            m.post_id = post.id
            m.slot = slot
            m.sort_order = i
        media.extend(rows)
    if media:
        await db.commit()

    # 随帖创建投票（可选）；编辑器里以 ![poll](0) 占位，创建后回填真实 id
    if data.poll is not None:
        poll = PostPoll(
            post_id=post.id,
            question=data.poll.question,
            multi=data.poll.multi,
            end_at=datetime.utcnow() + timedelta(days=data.poll.duration_days),
        )
        db.add(poll)
        await db.flush()
        for i, label in enumerate(data.poll.options):
            db.add(PostPollOption(poll_id=poll.id, label=label, sort_order=i))
        for ph in ("![poll](0)", "![poll](-1)"):
            if ph in post.content:
                post.content = post.content.replace(ph, f"![poll]({poll.id})", 1)
                break
        else:
            post.content = f"{post.content}\n![poll]({poll.id})"
        await db.commit()
        await db.refresh(post)

    game_name, game_cover = await _game_info(db, post.game_id)
    media_map = (await _media_map(db, [post.id])).get(post.id, [])
    poll_out = await _poll_out(db, post.id, current_user.id if current_user else None)
    return await _to_out(
        db, post, current_user, game_name, 0, 0, False, game_cover,
        media=media_map, poll=poll_out,
    )


@router.post("/media", response_model=list[PostMediaOut])
async def upload_post_media(
    files: list[UploadFile] = File(...),
    slot: str = Form("inline"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """发布页上传图片 / 视频：此时还没发帖，附件先以草稿态（post_id 为空）落库。

    slot=header 头图区（最多 18 张图，或 1 个视频，互斥）；
    slot=inline 正文内嵌（最多 9 个附件）。
    图片 ≤ 8MB（jpg/png/webp/gif），视频 ≤ 80MB（mp4/webm/mov）。
    """
    if slot not in ("header", "inline"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "slot 只支持 header / inline")
    if not files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选择文件")

    drafts = (
        await db.execute(
            select(PostMedia).where(
                PostMedia.user_id == current_user.id,
                PostMedia.post_id.is_(None),
                PostMedia.slot == slot,
            )
        )
    ).scalars().all()
    has_video_draft = any(m.kind == "video" for m in drafts)

    if slot == "header":
        # 头图区：图片与视频互斥
        want_video = any((f.content_type or "").lower() in ALLOWED_VIDEO for f in files)
        if want_video:
            if has_video_draft or any(m.kind == "image" for m in drafts):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "头图区只能上传 1 个视频，或全部为图片")
            if len(files) > 1:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "头图区最多上传 1 个视频")
            room = 1
        elif has_video_draft:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "已上传头图视频，不能再添加头图（二者互斥）")
        else:
            room = MAX_HEADER_IMAGES - len(drafts)
            if room <= 0:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"头图最多 {MAX_HEADER_IMAGES} 张")
            if len(files) > room:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"还能上传 {room} 张头图，本次选择了 {len(files)} 张"
                )
    else:
        room = MAX_MEDIA - len(drafts)
        if room <= 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"正文最多插入 {MAX_MEDIA} 个附件")
        if len(files) > room:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"还能上传 {room} 个附件，本次选择了 {len(files)} 个"
            )

    user_dir = os.path.join(MEDIA_ROOT, str(current_user.id))
    os.makedirs(user_dir, exist_ok=True)

    added: list[PostMedia] = []
    for f in files:
        ctype = (f.content_type or "").lower()
        if ctype in ALLOWED_IMAGE:
            kind, ext, limit = "image", ALLOWED_IMAGE[ctype], MAX_IMAGE_BYTES
        elif ctype in ALLOWED_VIDEO:
            kind, ext, limit = "video", ALLOWED_VIDEO[ctype], MAX_VIDEO_BYTES
        else:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "只支持图片（jpg/png/webp/gif）或视频（mp4/webm/mov）")
        body = await f.read()
        if len(body) > limit:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"文件超过大小限制（图片 {MAX_IMAGE_BYTES // 1024 // 1024}MB / 视频 {MAX_VIDEO_BYTES // 1024 // 1024}MB）",
            )
        # 文件名服务端生成，不信任客户端传入的名字
        name = f"{uuid.uuid4().hex}{ext}"
        with open(os.path.join(user_dir, name), "wb") as fp:
            fp.write(body)
        m = PostMedia(
            post_id=None,
            user_id=current_user.id,
            kind=kind,
            slot=slot,
            url=f"/uploads/posts/{current_user.id}/{name}",
            sort_order=len(drafts) + len(added),
        )
        db.add(m)
        added.append(m)

    await db.commit()
    for m in added:
        await db.refresh(m)
    # 顺带清理超过一天仍未发布的历史草稿文件与记录
    await _purge_stale_drafts(db, current_user.id)
    return [PostMediaOut.model_validate(m) for m in added]


async def _purge_stale_drafts(db: AsyncSession, user_id: int) -> None:
    """清理超过 24 小时仍未绑定帖子的附件（记录 + 磁盘文件），避免垃圾堆积。"""
    deadline = datetime.utcnow() - timedelta(hours=24)
    stale = (
        await db.execute(
            select(PostMedia).where(
                PostMedia.user_id == user_id,
                PostMedia.post_id.is_(None),
                PostMedia.created_at < deadline,
            )
        )
    ).scalars().all()
    for m in stale:
        rel = m.url.replace("/uploads/", "", 1)
        path = os.path.join(
            os.path.dirname(MEDIA_ROOT), rel.replace("/", os.sep)
        )
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
        await db.delete(m)
    if stale:
        await db.commit()


@router.delete("/media/{media_id}")
async def delete_post_media(
    media_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """发布页删除已上传但未采用的附件（仅本人可删）。"""
    m = await db.get(PostMedia, media_id)
    if not m or m.user_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "附件不存在")
    rel = m.url.replace("/uploads/", "", 1)
    path = os.path.join(os.path.dirname(MEDIA_ROOT), rel.replace("/", os.sep))
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass
    await db.delete(m)
    await db.commit()
    return {"ok": True}


@router.patch("/{post_id}", response_model=PostOut)
async def update_post(
    post_id: int,
    data: PostUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if not post:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "帖子不存在")
    if post.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只能修改自己的帖子")
    if data.title is not None:
        post.title = data.title
    if data.content is not None:
        post.content = data.content
    await db.commit()
    await db.refresh(post)
    author = (await db.execute(select(User).where(User.id == post.user_id))).scalar_one_or_none()
    game_name, game_cover = await _game_info(db, post.game_id)
    lc, cc = (await _counts(db, [post.id])).get(post.id, (0, 0))
    liked = await _liked_ids(db, current_user.id, [post.id])
    return await _to_out(db, post, author, game_name, lc, cc, post.id in liked, game_cover)


@router.delete("/{post_id}")
async def delete_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if not post:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "帖子不存在")
    if post.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只能删除自己的帖子")
    # comments / post_likes / post_marks / comment_likes / post_media 的外键无级联删除，先清子表再删帖
    await db.execute(
        CommentLike.__table__.delete().where(
            CommentLike.comment_id.in_(select(Comment.id).where(Comment.post_id == post_id))
        )
    )
    media_rows = (
        await db.execute(select(PostMedia).where(PostMedia.post_id == post_id))
    ).scalars().all()
    for m in media_rows:
        rel = m.url.replace("/uploads/", "", 1)
        path = os.path.join(os.path.dirname(MEDIA_ROOT), rel.replace("/", os.sep))
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
    await db.execute(PostMedia.__table__.delete().where(PostMedia.post_id == post_id))
    # 投票（FK 有级联，仍显式清理保持与其他子表一致的顺序）
    await db.execute(
        PostPollVote.__table__.delete().where(
            PostPollVote.poll_id.in_(select(PostPoll.id).where(PostPoll.post_id == post_id))
        )
    )
    await db.execute(
        PostPollOption.__table__.delete().where(
            PostPollOption.poll_id.in_(select(PostPoll.id).where(PostPoll.post_id == post_id))
        )
    )
    await db.execute(PostPoll.__table__.delete().where(PostPoll.post_id == post_id))
    await db.execute(Comment.__table__.delete().where(Comment.post_id == post_id))
    await db.execute(PostLike.__table__.delete().where(PostLike.post_id == post_id))
    await db.execute(PostMark.__table__.delete().where(PostMark.post_id == post_id))
    await db.delete(post)
    await db.commit()
    return {"detail": "已删除", "id": post_id}


@router.get("/marks", response_model=list[PostMarkOut])
async def my_marked_posts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """我的帖子收藏列表（个人中心），按收藏时间倒序，带封面与真实计数。

    注意：必须注册在 GET /{post_id} 之前，否则 /marks 会被动态路径遮蔽（422）。
    """
    like_sq = (
        select(PostLike.post_id, func.count(PostLike.id).label("lc"))
        .group_by(PostLike.post_id)
        .subquery()
    )
    cmt_sq = (
        select(Comment.post_id, func.count(Comment.id).label("cc"))
        .group_by(Comment.post_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(
                PostMark.post_id,
                PostMark.created_at.label("marked_at"),
                Post.title,
                Post.view_count,
                User.username.label("author_name"),
                func.coalesce(like_sq.c.lc, 0).label("like_count"),
                func.coalesce(cmt_sq.c.cc, 0).label("comment_count"),
            )
            .join(Post, Post.id == PostMark.post_id)
            .join(User, User.id == Post.user_id)
            .outerjoin(like_sq, like_sq.c.post_id == Post.id)
            .outerjoin(cmt_sq, cmt_sq.c.post_id == Post.id)
            .where(PostMark.user_id == current_user.id)
            .order_by(PostMark.created_at.desc())
        )
    ).all()
    if not rows:
        return []

    # 收藏帖子的封面：header/inline 首图（与社区列表封面口径一致）
    covers: dict[int, str | None] = {}
    for r in rows:
        if r.post_id in covers:
            continue
        url = (
            await db.execute(
                select(PostMedia.url)
                .where(PostMedia.post_id == r.post_id, PostMedia.kind == "image")
                .order_by(PostMedia.sort_order)
                .limit(1)
            )
        ).scalar()
        covers[r.post_id] = url

    return [
        PostMarkOut(
            post_id=r.post_id,
            marked_at=r.marked_at,
            title=r.title,
            author_name=r.author_name,
            cover_image=covers.get(r.post_id),
            like_count=int(r.like_count),
            comment_count=int(r.comment_count),
            view_count=int(r.view_count or 0),
        )
        for r in rows
    ]


@router.get("/{post_id}", response_model=PostOut)
async def get_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if not post:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "帖子不存在")
    # 浏览量 +1（真实计数）
    post.view_count = int(post.view_count or 0) + 1
    await db.commit()
    author = (await db.execute(select(User).where(User.id == post.user_id))).scalar_one_or_none()
    # 关联桌游完整信息（相关桌游卡片：中文名 / 英文名 / 年份 / 分类 / 封面）
    game_name = game_name_en = game_category = game_cover = None
    game_year = None
    if post.game_id:
        grow = (
            await db.execute(
                select(
                    BoardGame.name,
                    BoardGame.name_en,
                    BoardGame.year_published,
                    BoardGame.categories,
                    BoardGame.cover_image,
                ).where(BoardGame.id == post.game_id)
            )
        ).first()
        if grow:
            game_name, game_name_en, game_year, cats, game_cover = grow
            game_category = (cats or [None])[0] if cats else None
    lc, cc = (await _counts(db, [post.id])).get(post.id, (0, 0))
    liked = await _liked_ids(db, current_user.id if current_user else None, [post.id])
    # 收藏：当前用户是否已收藏 + 真实收藏总数
    marked = False
    mark_count = 0
    mark_rows = (
        await db.execute(
            select(PostMark.id, PostMark.user_id).where(PostMark.post_id == post_id)
        )
    ).all()
    mark_count = len(mark_rows)
    if current_user and any(uid == current_user.id for _, uid in mark_rows):
        marked = True
    return await _to_out(
        db,
        post,
        author,
        game_name,
        lc,
        cc,
        post.id in liked,
        game_cover,
        game_name_en=game_name_en,
        game_year=game_year,
        game_category=game_category,
        marked=marked,
        mark_count=mark_count,
        media=(await _media_map(db, [post.id])).get(post.id, []),
        poll=await _poll_out(db, post.id, current_user.id if current_user else None),
    )


@router.post("/{post_id}/mark", response_model=dict)
async def toggle_mark(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """收藏 / 取消收藏帖子（toggle），返回真实状态与总数。"""
    post = (await db.execute(select(Post.id).where(Post.id == post_id))).scalar_one_or_none()
    if not post:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "帖子不存在")
    existing = (
        await db.execute(
            select(PostMark).where(PostMark.post_id == post_id, PostMark.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if existing:
        await db.delete(existing)
        marked = False
    else:
        db.add(PostMark(post_id=post_id, user_id=current_user.id))
        marked = True
    await db.commit()
    mark_count = len(
        (
            await db.execute(select(PostMark.id).where(PostMark.post_id == post_id))
        ).scalars().all()
    )
    return {"marked": marked, "mark_count": mark_count}


@router.post("/{post_id}/poll/vote", response_model=PollOut)
async def vote_poll(
    post_id: int,
    data: PollVoteIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """给帖子投票：单选一人一票（重投覆盖）；多选传完整选项集合（全量替换）。截止后不可再投。"""
    poll = (
        await db.execute(select(PostPoll).where(PostPoll.post_id == post_id))
    ).scalar_one_or_none()
    if not poll:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "该帖子没有投票")
    if poll.end_at <= datetime.utcnow():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "投票已截止")

    valid_options = set(
        (
            await db.execute(
                select(PostPollOption.id).where(PostPollOption.poll_id == poll.id)
            )
        ).scalars().all()
    )
    chosen = set(data.option_ids)
    if not chosen.issubset(valid_options):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "包含无效的投票选项")
    if not poll.multi and len(chosen) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "单选投票只能选择一个选项")

    await db.execute(
        PostPollVote.__table__.delete().where(
            PostPollVote.poll_id == poll.id, PostPollVote.user_id == current_user.id
        )
    )
    for oid in chosen:
        db.add(PostPollVote(poll_id=poll.id, option_id=oid, user_id=current_user.id))
    await db.commit()
    out = await _poll_out(db, post_id, current_user.id)
    assert out is not None
    return out


@router.get("/{post_id}/comments", response_model=list[CommentOut])
async def list_comments(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    """评论列表（平铺，含作者头像与真实赞/踩数）。"""
    rows = (
        await db.execute(
            select(Comment, User.username, User.role, User.avatar)
            .join(User, User.id == Comment.user_id)
            .where(Comment.post_id == post_id)
            .order_by(Comment.created_at.asc(), Comment.id.asc())
        )
    ).all()
    cids = [c.id for c, _, _, _ in rows]
    # 批量聚合每条评论的赞/踩数
    count_rows = (
        await db.execute(
            select(
                CommentLike.comment_id,
                CommentLike.value,
                func.count(CommentLike.id),
            )
            .where(CommentLike.comment_id.in_(cids))
            .group_by(CommentLike.comment_id, CommentLike.value)
        )
    ).all() if cids else []
    counts: dict[int, dict[str, int]] = {}
    for cid, val, cnt in count_rows:
        bucket = counts.setdefault(cid, {"up": 0, "down": 0})
        if int(val) == 1:
            bucket["up"] = int(cnt)
        else:
            bucket["down"] = int(cnt)
    # 当前用户的赞/踩记录
    mine: dict[int, int] = {}
    if current_user and cids:
        mine_rows = (
            await db.execute(
                select(CommentLike.comment_id, CommentLike.value).where(
                    CommentLike.comment_id.in_(cids), CommentLike.user_id == current_user.id
                )
            )
        ).all()
        mine = {cid: int(val) for cid, val in mine_rows}
    return [
        CommentOut(
            id=c.id,
            post_id=c.post_id,
            user_id=c.user_id,
            parent_id=c.parent_id,
            content=c.content,
            created_at=c.created_at,
            author_name=uname,
            author_role=role,
            author_avatar=avatar,
            like_count=counts.get(c.id, {}).get("up", 0),
            dislike_count=counts.get(c.id, {}).get("down", 0),
            liked=mine.get(c.id) == 1,
            disliked=mine.get(c.id) == -1,
        )
        for c, uname, role, avatar in rows
    ]


@router.post("/{post_id}/comments", response_model=CommentOut)
async def create_comment(
    post_id: int,
    data: CommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if not post:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "帖子不存在")
    if data.parent_id is not None:
        parent_exists = (
            await db.execute(
                select(Comment.id).where(Comment.id == data.parent_id, Comment.post_id == post_id)
            )
        ).scalar_one_or_none()
        if parent_exists is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "回复的评论不存在")
    comment = Comment(post_id=post_id, user_id=current_user.id, parent_id=data.parent_id, content=data.content)
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return CommentOut(
        id=comment.id,
        post_id=comment.post_id,
        user_id=comment.user_id,
        parent_id=comment.parent_id,
        content=comment.content,
        created_at=comment.created_at,
        author_name=current_user.username,
        author_role=current_user.role,
        author_avatar=current_user.avatar,
    )


@router.post("/{post_id}/comments/{comment_id}/like", response_model=dict)
async def toggle_comment_like(
    post_id: int,
    comment_id: int,
    data: CommentLikeToggle,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """评论赞/踩（toggle）：同值再点取消，异值切换；赞与踩互斥。"""
    comment = (
        await db.execute(
            select(Comment).where(Comment.id == comment_id, Comment.post_id == post_id)
        )
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "评论不存在")
    value = 1 if data.value == 1 else -1
    existing = (
        await db.execute(
            select(CommentLike).where(
                CommentLike.comment_id == comment_id, CommentLike.user_id == current_user.id
            )
        )
    ).scalar_one_or_none()
    if existing and existing.value == value:
        await db.delete(existing)
    elif existing:
        existing.value = value
    else:
        db.add(CommentLike(comment_id=comment_id, user_id=current_user.id, value=value))
    await db.commit()
    up = (
        await db.execute(
            select(func.count(CommentLike.id)).where(
                CommentLike.comment_id == comment_id, CommentLike.value == 1
            )
        )
    ).scalar() or 0
    down = (
        await db.execute(
            select(func.count(CommentLike.id)).where(
                CommentLike.comment_id == comment_id, CommentLike.value == -1
            )
        )
    ).scalar() or 0
    # 提交后重查当前用户真实状态，避免 ORM 状态歧义
    mine = (
        await db.execute(
            select(CommentLike.value).where(
                CommentLike.comment_id == comment_id, CommentLike.user_id == current_user.id
            )
        )
    ).scalar_one_or_none()
    return {
        "like_count": int(up),
        "dislike_count": int(down),
        "liked": mine == 1,
        "disliked": mine == -1,
    }


@router.post("/{post_id}/like", response_model=dict)
async def toggle_like(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """点赞 / 取消点赞（真实记录，同一用户只记一次）。"""
    post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if not post:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "帖子不存在")
    exists = (
        await db.execute(
            select(PostLike.id).where(PostLike.post_id == post_id, PostLike.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if exists:
        like = (await db.execute(select(PostLike).where(PostLike.id == exists))).scalar_one()
        await db.delete(like)
        liked = False
    else:
        db.add(PostLike(post_id=post_id, user_id=current_user.id))
        liked = True
    await db.commit()
    count = (
        await db.execute(select(func.count(PostLike.id)).where(PostLike.post_id == post_id))
    ).scalar() or 0
    return {"liked": liked, "like_count": int(count)}
