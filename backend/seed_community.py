# -*- coding: utf-8 -*-
"""社区种子数据：真实玩家账号 + 官方公告 + 玩家讨论帖 + 回复 + 点赞。

- 账号真实可登录（密码统一 player123），不会产生虚假的评分 / 收藏数据；
- 帖子内容围绕本站真实收录的桌游（board_games 表），不虚构任何指标；
- 点赞与回复均写入 post_likes / comments 表，计数为真实聚合结果。
用法：
    PYTHONPATH=. python seed_community.py            # 写入（已存在则跳过）
    PYTHONPATH=. python seed_community.py --reset    # 清空社区数据后重写
"""
import asyncio
import json
import sys
from pathlib import Path

import os
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.database import engine
from app.core.security import hash_password
from app.models.board_game import BoardGame
from app.models.comment import Comment
from app.models.post import Post, PostLike
from app.models.user import User

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

ROOT = Path(__file__).resolve().parent
RESET = "--reset" in sys.argv
DEFAULT_PASSWORD = "player2026"


def resolve_password() -> str:
    """密码来源优先级：--password 参数 > 环境变量 > 默认值（避免把明文密码写死在脚本里）。"""
    if "--password" in sys.argv:
        idx = sys.argv.index("--password")
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return os.environ.get("TM_COMMUNITY_PASSWORD", DEFAULT_PASSWORD)

# ── 玩家账号（真实可登录） ─────────────────────────────
PLAYERS = [
    {"username": "桌游老张", "phone": "13800000001"},
    {"username": "米宝收纳控", "phone": "13800000002"},
    {"username": "周末开团", "phone": "13800000003"},
    {"username": "骰子狂人", "phone": "13800000004"},
    {"username": "新手求带", "phone": "13800000005"},
]

# ── 官方公告（admin 发布，自动置顶） ────────────────────
# 注：早期 3 条「【公告】…」说明帖已按需求移除；
# 现仅保留 seed_official_news.py 中更贴近真实的桌游官方公告。
OFFICIAL_POSTS = []

# ── 玩家讨论（围绕真实收录的桌游） ───────────────────────
DISCUSSIONS = [
    {
        "author": "桌游老张",
        "game": "brass-birmingham",
        "title": "伯明翰开局前两轮，运河还是铁路？",
        "content": (
            "带新人开了三次伯明翰，发现前两轮铺运河的节奏明显更好上手："
            "行动成本低、能立刻接上酿酒厂，新人不容易卡住。\n\n"
            "但老玩家普遍第一轮就抢铁路，第二时代直接爆分。你们一般怎么选？"
            "有没有开局就压铁路但第二时代资源断档的情况？"
        ),
        "comments": [
            ("周末开团", "新手局一定先运河，铁路晚一轮问题不大，运河期的钱够你撑到第二时代。"),
            ("骰子狂人", "抢铁路的前提是手上至少有 2 张能连到煤/铁的城市卡，不然就是空铺。"),
        ],
    },
    {
        "author": "米宝收纳控",
        "game": "ark-nova",
        "title": "方舟动物园收纳方案：卡牌分色 + 配件盒",
        "content": (
            "方舟的卡牌量真的夸张，官方内衬基本没法用。我的方案：\n"
            "1. 卡牌按颜色分四堆，用四个小号卡盒；\n"
            "2. 动物token按体型（小/中/大）分三格；\n"
            "3. 金钱和分数标记用独立小袋。\n\n"
            "摆桌时间从 15 分钟降到 6 分钟左右，收摊也快。有更优的方案欢迎交流。"
        ),
        "comments": [
            ("新手求带", "请问卡盒是哪家的？我买的尺寸放进去会顶盖。"),
            ("米宝收纳控", "回楼上：买之前先量内高，我用的是 66mm 高的那款，刚好不顶。"),
        ],
    },
    {
        "author": "周末开团",
        "game": "catan",
        "title": "四人局卡坦岛，怎么避免开局就被卡死？",
        "content": (
            "我们固定的四人群，每次有人开局选到被两边包夹的位置，第一轮就基本判死刑了。\n\n"
            "现在试过两个办法：一是建房阶段强制六边形轮流选点，二是允许开局重掷一次。你们有什么规矩？"
        ),
        "comments": [
            ("桌游老张", "直接引入「均衡开局」变体：先随机布一次，大家都不满意就整体重布。"),
        ],
    },
    {
        "author": "新手求带",
        "game": "azul",
        "title": "花砖物语第一次玩，总在扣分怎么办？",
        "content": (
            "上周第一次玩花砖，前两轮拿得很爽，后面墙上一排排不上就开始疯狂扣分，最后负分收场。\n\n"
            "有没有新手能立刻用上的拿砖原则？"
        ),
        "comments": [
            ("米宝收纳控", "核心原则：优先拿能立刻上墙的颜色，别为了凑数量拿没位置的砖。"),
            ("骰子狂人", "第一轮别贪，拿中间那堆的同一色最稳，扣分主要来自拿了放不下的砖。"),
        ],
    },
    {
        "author": "骰子狂人",
        "game": "gaia-project",
        "title": "盖亚计划种族选择：新手真的别碰那些特殊派系",
        "content": (
            "盖亚的派系平衡其实做得不错，但对新手来说差太多了。\n\n"
            "建议新手前两局就从最标准的几个派系里选，把「挖矿—升级—建联邦」的主线跑顺，"
            "再去看那些特殊派系的变形打法，不然很容易整局都在迷茫。"
        ),
        "comments": [
            ("周末开团", "同意，我们第二局才敢碰特殊派系，第一局老老实实跑主线收获最大。"),
        ],
    },
    {
        "author": "桌游老张",
        "game": "terraforming-mars",
        "title": "火星改造：公司卡要不要重抽？",
        "content": (
            "我们群里争论很久的一个问题：开局公司卡不满意要不要允许重抽一次？\n\n"
            "支持方说新手体验；反对方说重抽会让某些强公司出现率变高，破坏平衡。你们桌规矩是什么？"
        ),
        "comments": [
            ("骰子狂人", "我们允许每人抽 2 张选 1 张，既不破坏平衡也照顾新手。"),
            ("新手求带", "抽2选1这个方案听起来最舒服，下次我们群也这么办。"),
        ],
    },
    {
        "author": "米宝收纳控",
        "game": "splendor",
        "title": "璀璨宝石 2 人局的节奏是不是太快了？",
        "content": (
            "两人局经常 12 分钟就结束，感觉还没展开就终局了。\n\n"
            "试过提高贵族门槛到 15 分，节奏舒服很多。有人做过别的调整吗？"
        ),
        "comments": [],
    },
    {
        "author": "周末开团",
        "game": None,
        "title": "每周开团招募：周末下午固定局，欢迎新人",
        "content": (
            "我们每周六下午在固定场地开一局中重度策略，人数 3-5 人，剩 1-2 个位置长期开放。\n\n"
            "新手友好，开局前会花 15 分钟讲规则，游戏以 2-3 小时的重策为主。想来的在评论区留个言。"
        ),
        "comments": [
            ("新手求带", "报名！这周有位置吗？我可以早点来听规则。"),
            ("桌游老张", "我也去，可以带一盒伯明翰。"),
        ],
    },
    {
        "author": "新手求带",
        "game": None,
        "title": "新手求推荐：适合 2 人、规则 15 分钟讲完的游戏",
        "content": (
            "和对象两个人玩，希望规则简单、一局 30-45 分钟，最好有互动但不能纯吵架。\n\n"
            "目前看过花砖物语和七大奇迹对决，不知道还有没有别的推荐？"
        ),
        "comments": [
            ("周末开团", "七大奇迹对决很符合你的要求，规则短、互动强、一局刚好。"),
            ("米宝收纳控", "可以再看看王国米诺，讲完 5 分钟就能开局，两人局也不无聊。"),
        ],
    },
    {
        "author": "骰子狂人",
        "game": "root",
        "title": "ROOT 四人局阵营怎么配最平衡？",
        "content": (
            "我们固定四人，常用配置是猫+鸟+联盟+流浪者。\n\n"
            "但最近总觉得联盟发育太快，中期滚雪球停不下来。大家有没有更平衡的四人阵营组合？"
        ),
        "comments": [
            ("桌游老张", "试试把联盟换成商会，节奏会慢一点，四人局的拉扯更明显。"),
        ],
    },
]


async def ensure_users(session, password: str):
    pw = hash_password(password)
    out = {}
    for p in PLAYERS:
        u = (
            await session.execute(select(User).where(User.username == p["username"]))
        ).scalar_one_or_none()
        if u is None:
            u = User(
                username=p["username"],
                phone=p["phone"],
                password_hash=pw,
                role="user",
                is_active=True,
            )
            session.add(u)
            await session.flush()
        else:
            u.password_hash = pw  # 重跑时同步密码，保证与本次传入的一致
        out[p["username"]] = u
    await session.commit()
    print(f"玩家账号：{len(out)} 个（密码均为 {password}，可真实登录）")
    return out


async def main():
    async with SessionLocal() as session:
        if RESET:
            await session.execute(Comment.__table__.delete())
            await session.execute(PostLike.__table__.delete())
            await session.execute(Post.__table__.delete())
            await session.commit()
            print("已清空社区数据（帖子 / 回复 / 点赞）")

        admin = (
            await session.execute(select(User).where(User.role == "admin"))
        ).scalars().first()
        if not admin:
            print("未找到管理员账号，请先运行 seed_admin.py")
            return
        password = resolve_password()
        users = await ensure_users(session, password)

        # 桌游 slug → id（board_games 无 slug 列，映射取自前后端共用的 catalog.json）
        catalog_path = ROOT.parent / ".workbuddy" / "tmp" / "catalog.json"
        slug_to_id: dict[str, int] = {}
        if catalog_path.exists():
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            items = catalog if isinstance(catalog, list) else catalog.get("games", [])
            slug_to_id = {g["slug"]: g["id"] for g in items if g.get("slug")}
        valid_ids = set((await session.execute(select(BoardGame.id))).scalars().all())

        existing = (
            await session.execute(select(Post.title))
        ).scalars().all()
        existing_set = set(existing)

        created = 0
        # 官方公告
        for item in OFFICIAL_POSTS:
            if item["title"] in existing_set:
                continue
            p = Post(
                user_id=admin.id,
                game_id=item["game_id"],
                title=item["title"],
                content=item["content"],
                is_pinned=True,
            )
            session.add(p)
            created += 1
        await session.commit()

        # 玩家讨论
        posts = []
        for item in DISCUSSIONS:
            if item["title"] in existing_set:
                continue
            author = users.get(item["author"])
            if not author:
                continue
            # 关联不到真实桌游就留空（不虚构关联关系）
            gid = slug_to_id.get(item["game"]) if item.get("game") else None
            if gid is not None and gid not in valid_ids:
                gid = None
            p = Post(
                user_id=author.id,
                game_id=gid,
                title=item["title"],
                content=item["content"],
                is_pinned=False,
            )
            session.add(p)
            posts.append((p, item))
            created += 1
        await session.commit()
        for p, _ in posts:
            await session.refresh(p)

        # 回复 + 点赞（真实写入）
        comments = 0
        likes = 0
        for p, item in posts:
            for uname, text in item.get("comments", []):
                u = users.get(uname)
                if not u:
                    continue
                session.add(Comment(post_id=p.id, user_id=u.id, content=text))
                comments += 1
            # 每个讨论帖让作者以外的两名玩家点赞
            likers = [u for name, u in users.items() if name != item["author"]][:2]
            for u in likers:
                session.add(PostLike(post_id=p.id, user_id=u.id))
                likes += 1
        # 官方公告各来一次点赞
        official = (
            await session.execute(select(Post).where(Post.user_id == admin.id))
        ).scalars().all()
        for p in official:
            for u in list(users.values())[:3]:
                session.add(PostLike(post_id=p.id, user_id=u.id))
                likes += 1
        await session.commit()

        print(f"新增帖子 {created} 条（官方 {len(OFFICIAL_POSTS)} / 讨论 {len(DISCUSSIONS)}）")
        print(f"新增回复 {comments} 条、点赞 {likes} 条")
        total_posts = (await session.execute(select(Post.id))).scalars().all()
        print(f"社区现有帖子总数：{len(total_posts)}")


if __name__ == "__main__":
    asyncio.run(main())
