"""把真实采集的 51 款桌游灌入 board_games，并生成一批演示玩家评分。

用途：
  1) 桌游数据来自 backend/data/catalog.json（BGG 接口真实采集，随仓库分发，非虚构）；
  2) 评分用于「本站玩家评分排行榜」。由于系统刚上线没有真实玩家评分，
     脚本会创建一批**演示账号**（用户名形如 player1001，密码 player123）
     并写入评分，使排行榜可用。这些是种子数据，不是真实玩家行为，
     一旦有真实用户评分，可在管理端删除演示账号后重算。

运行：python seed_catalog.py         （幂等：已存在则跳过/更新）
      python seed_catalog.py --reset （清空演示账号与其评分后重建）
"""
import asyncio
import hashlib
import json
import os
import random
import sys

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import hash_password
from app.models.board_game import BoardGame
from app.models.collection import Collection
from app.models.review import Review
from app.models.user import User

CATALOG = os.path.join(os.path.dirname(__file__), "data", "catalog.json")
DEMO_PREFIX = "player"
DEMO_PASSWORD = "player123"
DEMO_USER_COUNT = 60

RESET = "--reset" in sys.argv

engine = create_async_engine(settings.DATABASE_URL)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def stable_seed(slug: str) -> int:
    """由 slug 派生的稳定随机种子，保证多次运行结果一致。"""
    return int(hashlib.md5(slug.encode("utf-8")).hexdigest()[:8], 16)


def to_int(v, default=0):
    """BGG 接口把人数/年份等返回成字符串，这里统一转整数。"""
    if v is None or v == "":
        return default
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return default


async def seed_games(session: AsyncSession, catalog: list[dict]) -> int:
    """按 catalog 的固定 id 灌库，保证前端 id 与数据库 id 一致。"""
    created = updated = 0
    for c in catalog:
        game = await session.get(BoardGame, c["id"])
        if game is None:
            game = BoardGame(id=c["id"])
            session.add(game)
            created += 1
        else:
            updated += 1
        game.name = c["name"]
        game.name_en = c["name_en"]
        game.description = c["description"]
        game.cover_image = c["cover_image"] or None
        game.min_players = to_int(c["min_players"])
        game.max_players = to_int(c["max_players"])
        game.play_time_minutes = to_int(c["play_time_minutes"])
        game.min_age = to_int(c["min_age"])
        game.categories = c["categories"]
        game.mechanics = c["mechanics"]
        game.publisher = c["publisher"] or None
        game.year_published = to_int(c["year_published"])
    await session.commit()
    print(f"桌游：新建 {created} 款，更新 {updated} 款（共 {len(catalog)} 款）")
    return len(catalog)


async def clear_demo(session: AsyncSession) -> None:
    ids = (
        await session.execute(
            select(User.id).where(User.username.like(f"{DEMO_PREFIX}%"))
        )
    ).scalars().all()
    if not ids:
        return
    await session.execute(delete(Review).where(Review.user_id.in_(ids)))
    await session.execute(delete(User).where(User.id.in_(ids)))
    await session.commit()
    print(f"已清理演示账号 {len(ids)} 个及其评分")


async def seed_ratings(session: AsyncSession, catalog: list[dict]) -> int:
    """创建演示账号并写入评分，随后按真实评测重算每款游戏的均分。"""
    pw = hash_password(DEMO_PASSWORD)
    users = []
    for i in range(1, DEMO_USER_COUNT + 1):
        username = f"{DEMO_PREFIX}{1000 + i}"
        # 手机号必须唯一且符合 1[3-9]\d{9}
        phone = f"139{10000000 + i:08d}"[:11]
        u = (
            await session.execute(select(User).where(User.username == username))
        ).scalar_one_or_none()
        if u is None:
            u = User(
                username=username,
                phone=phone,
                password_hash=pw,
                role="user",
                is_active=True,
            )
            session.add(u)
            users.append(u)
        else:
            users.append(u)
    await session.commit()
    for u in users:
        await session.refresh(u)
    print(f"演示账号：{len(users)} 个（密码均为 {DEMO_PASSWORD}）")

    total = 0
    for u in users:
        rng = random.Random(stable_seed(u.username))
        picks = rng.sample(catalog, rng.randint(8, 25))
        for c in picks:
            exists = (
                await session.execute(
                    select(Review).where(
                        Review.user_id == u.id, Review.game_id == c["id"]
                    )
                )
            ).scalar_one_or_none()
            if exists:
                continue
            # 每款游戏有一个稳定的"口碑基线"，玩家在此基础上小幅波动
            base_rng = random.Random(stable_seed(c["slug"]))
            base = base_rng.uniform(5.8, 9.2)
            rating = max(1, min(10, round(base + rng.uniform(-1.1, 1.1))))
            session.add(Review(user_id=u.id, game_id=c["id"], rating=rating,
                               content=None, like_count=0))
            total += 1
    await session.commit()
    print(f"演示评分：写入 {total} 条")

    # 按真实评测重算均分与评分人数
    for c in catalog:
        row = (
            await session.execute(
                select(func.avg(Review.rating), func.count(Review.id)).where(
                    Review.game_id == c["id"]
                )
            )
        ).first()
        avg, cnt = (row or (None, 0))
        game = await session.get(BoardGame, c["id"])
        if game:
            game.avg_rating = round(float(avg), 2) if avg is not None else 0.0
            game.rating_count = int(cnt or 0)
    await session.commit()
    return total


async def seed_marks(session: AsyncSession, catalog: list[dict]) -> int:
    """为演示账号补「想玩 / 玩过」收藏标记，使热门榜可用（同样是种子数据）。"""
    users = (
        await session.execute(select(User).where(User.username.like(f"{DEMO_PREFIX}%")))
    ).scalars().all()
    total = 0
    for u in users:
        rng = random.Random(stable_seed(u.username + ":marks"))
        picks = rng.sample(catalog, rng.randint(6, 20))
        for c in picks:
            exists = (
                await session.execute(
                    select(Collection.id).where(
                        Collection.user_id == u.id, Collection.game_id == c["id"]
                    )
                )
            ).scalar_one_or_none()
            if exists:
                continue
            reviewed = (
                await session.execute(
                    select(Review.id).where(
                        Review.user_id == u.id, Review.game_id == c["id"]
                    )
                )
            ).scalar_one_or_none()
            # 玩过并写了评测的比例最高；没评测的大多是「想玩」
            status = "played" if reviewed else ("want" if rng.random() < 0.7 else "played")
            session.add(Collection(user_id=u.id, game_id=c["id"], status=status))
            total += 1
    await session.commit()
    print(f"演示标记：写入 {total} 条（想玩 / 玩过）")
    return total


async def main():
    with open(CATALOG, encoding="utf-8") as f:
        catalog = json.load(f)
    async with SessionLocal() as session:
        if RESET:
            await clear_demo(session)
        await seed_games(session, catalog)

        # 2026-10-09 起不再灌演示用户 / 评分 / 标记（不再创建假账号刷数据）。
        # 如确需演示数据，可临时恢复调用：seed_ratings(session, catalog) + seed_marks(session, catalog)。

        rows = (
            await session.execute(
                select(BoardGame.name, BoardGame.avg_rating, BoardGame.rating_count)
                .order_by(BoardGame.avg_rating.desc())
                .limit(5)
            )
        ).all()
        print("当前评分最高的 5 款（按本站玩家评分）：")
        for n, a, c in rows:
            print(f"  {n:<20s} {a:.2f} 分  {c} 人评分")


if __name__ == "__main__":
    asyncio.run(main())
