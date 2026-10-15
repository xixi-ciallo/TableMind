"""管理员端标签管理。

标签来源分成两类，但都落在 game_tags 表统一维护：
  1) 同步自现有桌游的真实 categories / mechanics（"原有标签"）
  2) 管理员手工新建

关键能力：
  - list   返回每个标签被多少款桌游引用（usage_count）
  - sync   把当前库内桌游用到的标签补齐到 game_tags
  - update 改名时会级联更新所有桌游的 categories / mechanics，避免产生悬空标签
  - delete 删除时会同步摘掉桌游上的引用，并回报受影响桌游数
"""
from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.game_tag import GameTag

router = APIRouter()

# categories / mechanics 两个列名是固定的白名单，绝不接受外部输入拼 SQL
_COLUMN = {"category": "categories", "mechanic": "mechanics"}


class TagCreate(BaseModel):
    name: str = Field(max_length=100)
    type: str = Field(pattern="^(category|mechanic)$")


class TagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    type: str
    usage_count: int = 0


class TagSyncOut(BaseModel):
    created: int
    existing: int
    categories: int
    mechanics: int


async def _usage_count(db: AsyncSession, name: str, column: str) -> int:
    row = await db.execute(
        text(f"SELECT count(*) FROM board_games WHERE {column} @> jsonb_build_array(CAST(:n AS text))"),
        {"n": name},
    )
    return int(row.scalar() or 0)


async def _attach_usage(db: AsyncSession, tags: Sequence[GameTag]) -> list[dict]:
    out = []
    for t in tags:
        column = _COLUMN.get(t.type, "categories")
        out.append(
            {
                "id": t.id,
                "name": t.name,
                "type": t.type,
                "usage_count": await _usage_count(db, t.name, column),
            }
        )
    return out


@router.get("", response_model=list[TagOut])
async def list_tags(
    type: str | None = None,
    include_empty: bool = True,
    db: AsyncSession = Depends(get_db),
):
    """标签列表。默认包含未被任何桌游引用的标签，便于管理员清理。"""
    rows = (await db.execute(text("SELECT id, name, type FROM game_tags ORDER BY type, name"))).all()
    items = [
        {"id": r[0], "name": r[1], "type": r[2], "usage_count": await _usage_count(db, r[1], _COLUMN.get(r[2], "categories"))}
        for r in rows
    ]
    if type:
        items = [i for i in items if i["type"] == type]
    if not include_empty:
        items = [i for i in items if i["usage_count"] > 0]
    return items


@router.post("/sync", response_model=TagSyncOut)
async def sync_tags(db: AsyncSession = Depends(get_db)):
    """把当前库内桌游实际用到的 categories / mechanics 同步进 game_tags。

    幂等：已存在的同名同类型标签不会重复创建。
    """
    cats = [r[0] for r in (await db.execute(text("SELECT DISTINCT jsonb_array_elements_text(categories) AS t FROM board_games"))).all()]
    mecs = [r[0] for r in (await db.execute(text("SELECT DISTINCT jsonb_array_elements_text(mechanics) AS t FROM board_games"))).all()]

    existing = {
        (r[0], r[1])
        for r in (await db.execute(text("SELECT name, type FROM game_tags"))).all()
    }

    created = 0
    for name, ttype in [(c, "category") for c in cats] + [(m, "mechanic") for m in mecs]:
        key = (name, ttype)
        if not name or key in existing:
            continue
        db.add(GameTag(name=name, type=ttype))
        existing.add(key)
        created += 1

    await db.commit()
    return TagSyncOut(
        created=created,
        existing=len(existing) - created,
        categories=len(cats),
        mechanics=len(mecs),
    )


@router.post("", response_model=TagOut, status_code=201)
async def create_tag(data: TagCreate, db: AsyncSession = Depends(get_db)):
    exists = (
        await db.execute(
            text("SELECT id FROM game_tags WHERE name = :n AND type = :t"),
            {"n": data.name, "t": data.type},
        )
    ).first()
    if exists:
        raise HTTPException(409, "同名同类型标签已存在")

    tag = GameTag(name=data.name, type=data.type)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return {
        "id": tag.id,
        "name": tag.name,
        "type": tag.type,
        "usage_count": await _usage_count(db, tag.name, _COLUMN[tag.type]),
    }


@router.put("/{tag_id}", response_model=TagOut)
async def update_tag(
    tag_id: int, data: TagCreate, db: AsyncSession = Depends(get_db)
):
    tag = await db.get(GameTag, tag_id)
    if not tag:
        raise HTTPException(404, "标签不存在")

    dup = (
        await db.execute(
            text("SELECT id FROM game_tags WHERE name = :n AND type = :t AND id <> :id"),
            {"n": data.name, "t": data.type, "id": tag_id},
        )
    ).first()
    if dup:
        raise HTTPException(409, "同名同类型标签已存在")

    old_name, old_type = tag.name, tag.type
    tag.name = data.name
    tag.type = data.type

    # 级联：把桌游上引用的旧标签改成新值（跨类型时先从旧列移除，再加到新列）
    old_col, new_col = _COLUMN[old_type], _COLUMN[data.type]
    if old_col == new_col and old_name != data.name:
        await db.execute(
            text(
                f"""
                UPDATE board_games
                SET {old_col} = (
                    SELECT jsonb_agg(CASE WHEN e = to_jsonb(CAST(:old AS text)) THEN to_jsonb(CAST(:new AS text)) ELSE e END)
                    FROM jsonb_array_elements({old_col}) AS e
                )
                WHERE {old_col} @> jsonb_build_array(CAST(:old AS text))
                """
            ),
            {"old": old_name, "new": data.name},
        )
    elif old_col != new_col:
        await db.execute(
            text(
                f"""
                UPDATE board_games
                SET {old_col} = COALESCE((
                    SELECT jsonb_agg(e) FROM jsonb_array_elements({old_col}) AS e
                    WHERE e <> to_jsonb(CAST(:old AS text))
                ), '[]'::jsonb)
                WHERE {old_col} @> jsonb_build_array(CAST(:old AS text))
                """
            ),
            {"old": old_name},
        )

    await db.commit()
    await db.refresh(tag)
    return {
        "id": tag.id,
        "name": tag.name,
        "type": tag.type,
        "usage_count": await _usage_count(db, tag.name, new_col),
    }


@router.delete("/{tag_id}")
async def delete_tag(tag_id: int, db: AsyncSession = Depends(get_db)):
    tag = await db.get(GameTag, tag_id)
    if not tag:
        raise HTTPException(404, "标签不存在")

    column = _COLUMN.get(tag.type, "categories")
    # 先统计再摘除引用，保持桌游数据里不残留悬空标签
    affected = await _usage_count(db, tag.name, column)
    if affected:
        await db.execute(
            text(
                f"""
                UPDATE board_games
                SET {column} = COALESCE((
                    SELECT jsonb_agg(e) FROM jsonb_array_elements({column}) AS e
                    WHERE e <> to_jsonb(CAST(:n AS text))
                ), '[]'::jsonb)
                WHERE {column} @> jsonb_build_array(CAST(:n AS text))
                """
            ),
            {"n": tag.name},
        )

    await db.delete(tag)
    await db.commit()
    return {"detail": "已删除", "affected_games": affected}
