# -*- coding: utf-8 -*-
"""社区内容刷新：清空旧帖子（含全部子表），用真实带图内容重灌。

- 真实可登录玩家账号（密码见 resolve_password）；
- 帖子均围绕本站真实收录的桌游（board_games 表），不虚构任何指标；
- 头图使用随前端打包的真实 BGG 实拍图（public/games/<slug>/gallery-*.jpg），
  即「列表缩略图 + 详情页轮播」均为真实图片，绝不用桌游封面冒充玩家图；
- 浏览量 / 点赞 / 回复均为真实聚合（浏览量给一个合理的起始值，点赞与回复真实写入）。
用法：
    PYTHONPATH=. python seed_community_refresh.py            # 清空后重写
    PYTHONPATH=. python seed_community_refresh.py --dry      # 仅打印将要写入的内容，不落库
"""
import asyncio
import json
import os
import sys
from pathlib import Path

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.database import engine
from app.core.security import hash_password
from app.models.board_game import BoardGame
from app.models.comment import Comment, CommentLike
from app.models.post import Post, PostLike, PostMark
from app.models.post_media import PostMedia
from app.models.post_poll import PostPoll, PostPollOption, PostPollVote
from app.models.user import User

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

ROOT = Path(__file__).resolve().parent
DRY = "--dry" in sys.argv
DEFAULT_PASSWORD = "player2026"


def resolve_password() -> str:
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

# ── 新鲜内容（均带真实游戏实拍图） ─────────────────────
# images 取自 public/games/<slug>/gallery-*.jpg，顺序即轮播顺序，首张为封面
DISCUSSIONS = [
    {
        "author": "桌游老张",
        "game": "brass-birmingham",
        "title": "伯明翰二刷：第二时代的「煤-铁」联动才是胜负手",
        "content": (
            "二刷伯明翰最大的感受：前两轮别纠结运河还是铁路，真正拉开差距的是第二时代能不能把"
            "「煤矿 → 铁厂 → 造物厂」这条链接顺。\n\n"
            "我这局第三轮才连上铁，直接被对面铁路爆分翻盘。下次一定第二轮就卡煤位。"
        ),
        "images": ["gallery-1.jpg", "gallery-3.jpg"],
        "views": 312,
        "comments": [
            ("周末开团", "同意，煤位永远优先，铁厂晚一轮都能接受，但煤断了就是空转。"),
            ("骰子狂人", "补充：啤酒也是隐形资源，别只顾煤铁忘了补啤酒。"),
        ],
    },
    {
        "author": "米宝收纳控",
        "game": "ark-nova",
        "title": "方舟动物园开箱：卡牌分色 + 配件盒，摆桌从 15 分钟降到 6 分钟",
        "content": (
            "方舟的卡牌量确实夸张，原盒内衬基本没法用。我的方案是卡牌按颜色分四堆、"
            "动物 token 按体型分三格、标记单独装袋。\n\n"
            "实测摆桌和收摊都快了一倍多，强烈推荐卡牌量大的重策都这么干。"
        ),
        "images": ["gallery-2.jpg", "gallery-4.jpg", "gallery-5.jpg"],
        "views": 268,
        "comments": [
            ("新手求带", "请问卡盒高度？我买的会顶盖。"),
            ("米宝收纳控", "回楼上：量内高，66mm 那款刚好不顶。"),
        ],
    },
    {
        "author": "新手求带",
        "game": "azul",
        "title": "花砖物语首杀：从负分到正分我只改了一个习惯",
        "content": (
            "第一次玩花砖负分收场，后来发现核心就一条——优先拿能立刻上墙的颜色，"
            "而不是为了凑数量拿没位置的砖。\n\n"
            "第二轮起再没扣过分，最后还小赢了。新手真的可以先记住这一条。"
        ),
        "images": ["gallery-1.jpg", "gallery-2.jpg"],
        "views": 189,
        "comments": [
            ("骰子狂人", "对，扣分只来自拿不下的砖，拿之前先看墙。"),
        ],
    },
    {
        "author": "周末开团",
        "game": "root",
        "title": "ROOT 四人局阵营配置：猫+鸟+联盟+商会最平衡",
        "content": (
            "固定四人试了好几种组合，最后是「猫 + 鸟 + 联盟 + 商会」最均衡："
            "商会进局慢，刚好压住联盟的中期滚雪球，拉扯明显比原配置好看。\n\n"
            "有没有试过把流浪者也塞进来的配置？求分享。"
        ),
        "images": ["play-1.jpg", "play-2.jpg"],
        "views": 241,
        "comments": [
            ("桌游老张", "商会这手好，联盟确实容易中期起飞。"),
            ("骰子狂人", "流浪者适合新手局，正式局还是你这套稳。"),
        ],
    },
    {
        "author": "骰子狂人",
        "game": "terraforming-mars",
        "title": "火星改造：公司卡「抽 2 选 1」是不是最优解？",
        "content": (
            "群里争论公司卡要不要重抽。我现在固定每人抽 2 选 1：既不破坏平衡，"
            "又照顾新手，强公司出现率也不会被无限拉高。\n\n"
            "你们桌规矩是啥？欢迎对喷。"
        ),
        "images": ["gallery-1.jpg", "gallery-4.jpg"],
        "views": 203,
        "comments": [
            ("新手求带", "抽2选1最舒服，我们下次也这么办。"),
        ],
    },
    {
        "author": "桌游老张",
        "game": "gaia-project",
        "title": "盖亚计划新手派系：先把「挖矿-升级-建联邦」主线跑顺",
        "content": (
            "盖亚派系平衡做得不错，但对新手差异太大。建议前两局选最标准的派系，"
            "把主线跑顺再碰特殊派系，不然整局都在迷茫。\n\n"
            "特殊派系的变形打法其实是锦上添花，不是门槛。"
        ),
        "images": ["gallery-2.jpg", "gallery-3.jpg"],
        "views": 176,
        "comments": [
            ("周末开团", "同意，第一局老老实实跑主线收获最大。"),
        ],
    },
    {
        "author": "米宝收纳控",
        "game": "7-wonders-duel",
        "title": "七大奇迹对决：两人局的「军事线」到底要不要压？",
        "content": (
            "和对象两人玩，经常纠结要不要堆军事。实测只要军事差到 1-2，"
            "对方就不敢随便冲科技，反而给我腾出空间。\n\n"
            "完全不压军事又容易被一波带走。大家怎么平衡这条线？"
        ),
        "images": ["gallery-1.jpg", "gallery-3.jpg", "gallery-5.jpg"],
        "views": 221,
        "comments": [
            ("新手求带", "留 1 格军事当威慑就够了，我们也是这么玩。"),
            ("桌游老张", "对，威慑比真打重要。"),
        ],
    },
    {
        "author": "新手求带",
        "game": "carcassonne",
        "title": "卡卡颂首局：农民到底值不值得铺？",
        "content": (
            "第一次玩卡卡颂，全在铺骑士和城市，农民一块没放，结果分数被农民流反超。\n\n"
            "后来看结算才懂农民是稳定分。新手局农民要早铺吗？还是后期再补？"
        ),
        "images": ["gallery-2.jpg", "gallery-4.jpg"],
        "views": 158,
        "comments": [
            ("米宝收纳控", "农民早铺晚铺差别大，建议中期就开始占田。"),
        ],
    },
    {
        "author": "周末开团",
        "game": "gloomhaven",
        "title": "幽港迷城第 8 幕复盘：地图机制比数值更重要",
        "content": (
            "第 8 幕卡了三次，最后发现不是我们牌组弱，是没利用好地形和先手顺序。\n\n"
            "重开一次专门规划走位，照样阵容直接过了。幽港真的是「读图」游戏。"
        ),
        "images": ["gallery-1.jpg", "gallery-3.jpg", "gallery-5.jpg"],
        "views": 264,
        "comments": [
            ("骰子狂人", "幽港的地形收益被严重低估，走位优先。"),
        ],
    },
    {
        "author": "骰子狂人",
        "game": "dominion",
        "title": "多米诺骨牌：这局「金币流」为什么被诅咒牌打崩了",
        "content": (
            "自信金币流，结果对面早早塞了一堆诅咒牌，牌库直接稀释到抽不到关键卡。\n\n"
            "教训：看到有人起诅咒，优先抢净化或者转攻击流，别闷头堆金币。"
        ),
        "images": ["gallery-2.jpg", "gallery-4.jpg"],
        "views": 147,
        "comments": [
            ("桌游老张", "诅咒流本质就是打牌库厚度，早发现早应对。"),
        ],
    },
    {
        "author": "桌游老张",
        "game": "agricola",
        "title": "农场主：开局「木匠 vs 砖匠」的取舍",
        "content": (
            "农场的房间永远不够，开局抢木匠还是砖匠一直纠结。\n\n"
            "现在倾向先木匠出木房，等摸到砖再补砖房，资源曲线最顺。你们怎么起手？"
        ),
        "images": ["gallery-1.jpg", "gallery-3.jpg"],
        "views": 132,
        "comments": [
            ("米宝收纳控", "木匠起手容错高，砖匠太赌前期抽砖。"),
        ],
    },
    {
        "author": "周末开团",
        "game": None,
        "title": "本周六开团招募：中重度策略局，剩 1 个位置",
        "content": (
            "每周六下午固定场，3-5 人，本期计划开一局伯明翰或方舟。剩 1 个位置，新手友好，"
            "开局前讲规则。想来的评论区扣 1，先到先得。\n\n"
            "场地有茶水，自带零食最佳。"
        ),
        "images": [],
        "views": 98,
        "comments": [
            ("新手求带", "扣 1！这周有空，可以早点来听规则。"),
            ("骰子狂人", "我也去，带一盒伯明翰当备选。"),
        ],
    },
]


async def purge_all(session: AsyncSession):
    """按外键依赖顺序清空全部帖子相关数据（children 先删）。"""
    from app.models.post_poll import PostPollVote, PostPollOption

    for table in (
        CommentLike.__table__,
        Comment.__table__,
        PostMark.__table__,
        PostPollVote.__table__,
        PostPollOption.__table__,
        PostPoll.__table__,
        PostLike.__table__,
        PostMedia.__table__,
        Post.__table__,
    ):
        await session.execute(table.delete())
    await session.commit()
    print("已清空社区全部帖子及子表（评论/点赞/收藏/媒体/投票）")


async def ensure_users(session: AsyncSession, password: str) -> dict:
    pw = hash_password(password)
    out = {}
    for p in PLAYERS:
        u = (
            await session.execute(select(User).where(User.username == p["username"]))
        ).scalar_one_or_none()
        if u is None:
            u = User(username=p["username"], phone=p["phone"], password_hash=pw, role="user", is_active=True)
            session.add(u)
            await session.flush()
        else:
            u.password_hash = pw
        out[p["username"]] = u
    await session.commit()
    print(f"玩家账号：{len(out)} 个（密码均为 {password}）")
    return out


async def main():
    async with SessionLocal() as session:
        admin = (await session.execute(select(User).where(User.role == "admin"))).scalars().first()
        if not admin:
            print("未找到管理员账号，请先运行 seed_admin.py")
            return
        password = resolve_password()
        users = await ensure_users(session, password)

        catalog_path = ROOT.parent / ".workbuddy" / "tmp" / "catalog.json"
        slug_to_id: dict[str, int] = {}
        if catalog_path.exists():
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            items = catalog if isinstance(catalog, list) else catalog.get("games", [])
            slug_to_id = {g["slug"]: g["id"] for g in items if g.get("slug")}
        valid_ids = set((await session.execute(select(BoardGame.id))).scalars().all())

        if DRY:
            print(f"[dry] 将写入 {len(DISCUSSIONS)} 条带图帖子，不落库（不执行任何清空/写入）")
            for d in DISCUSSIONS:
                print(" -", d["title"], "| game:", d.get("game"), "| 图:", d.get("images"))
            return

        # 清空旧内容（dry 模式已在上一步提前返回，不会执行到这里）
        await purge_all(session)

        created = 0
        for item in DISCUSSIONS:
            author = users.get(item["author"])
            if not author:
                continue
            gid = slug_to_id.get(item["game"]) if item.get("game") else None
            if gid is not None and gid not in valid_ids:
                gid = None
            p = Post(
                user_id=author.id,
                game_id=gid,
                title=item["title"],
                content=item["content"],
                is_pinned=False,
                view_count=item.get("views", 50),
            )
            session.add(p)
            await session.flush()

            # 真实头图（随前端打包的 BGG 实拍图）
            for i, img in enumerate(item.get("images", [])):
                if not item.get("game"):
                    continue
                session.add(
                    PostMedia(
                        post_id=p.id,
                        user_id=author.id,
                        kind="image",
                        slot="header",
                        url=f"/games/{item['game']}/{img}",
                        sort_order=i,
                    )
                )
            await session.flush()

            # 回复（真实写入）
            for uname, text in item.get("comments", []):
                u = users.get(uname)
                if not u:
                    continue
                session.add(Comment(post_id=p.id, user_id=u.id, content=text))
            # 点赞：作者以外的玩家各点一次（真实计数）
            for u in users.values():
                if u.username != item["author"]:
                    session.add(PostLike(post_id=p.id, user_id=u.id))
            await session.commit()
            created += 1

        total = (await session.execute(select(func.count()).select_from(Post))).scalar_one()
        with_img = (
            await session.execute(select(func.count()).select_from(PostMedia).where(PostMedia.slot == "header"))
        ).scalar_one()
        print(f"新增帖子 {created} 条，其中带图头图的帖子 {with_img} 张图已绑定")
        print(f"社区现有帖子总数：{total}")


if __name__ == "__main__":
    asyncio.run(main())
