# -*- coding: utf-8 -*-
"""用户评测种子数据：5 位玩家对站内真实桌游的评分与短评。

与 seed_catalog.py 的「演示账号刷分」不同，这里只用站内已有的 5 个玩家账号，
评分与短评都对应真实收录的桌游，并同步「玩过」标记、评测点赞数与桌游均分。

用法：
    PYTHONPATH=. python seed_reviews.py          # 幂等：已存在的评分不覆盖
    PYTHONPATH=. python seed_reviews.py --reset  # 先清空这 5 位玩家的评分再写入
"""
import asyncio
import sys
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.database import engine
from app.models.board_game import BoardGame
from app.models.collection import Collection
from app.models.review import Review, ReviewLike
from app.models.user import User

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
RESET = "--reset" in sys.argv

# 玩家 -> {桌游名: (评分, 短评或 None)}
# 短评为空表示只打分不写字（站内评分与评测分开统计）
REVIEWS: dict[str, dict[str, tuple[int, str | None]]] = {
    "桌游老张": {
        "工业革命：伯明翰": (10, "运河期抢煤位、铁路期连铁厂，第三轮能不能把煤铁链跑顺基本决定胜负。二刷依旧觉得是近年最好的重策，规则紧但不冗余。"),
        "盖亚计划": (9, "派系差异大，新手前两局建议先用标准派系把「挖矿-升级-建联邦」主线跑顺，再碰特殊派系。"),
        "瘟疫危机：传承（第一季）": (9, "把「输了就永久改变版图」做成了叙事，每局结束都要讨论半天下一步。适合固定四人长期开。"),
        "殖民火星": (9, None),
        "帝国曙光（第 4 版）": (9, None),
        "历史巨轮：人类文明新篇章": (9, None),
        "幽港迷城": (9, None),
        "神秘大地": (8, None),
        "波多黎各": (9, None),
        "方舟动物园": (9, None),
        "卡坦岛": (7, None),
        "瘟疫危机": (8, "合作游戏的老祖宗，行动点有限又要全图救火，四人局全程都在讨论，带新人很合适。"),
        "镰刀战争": (8, None),
        "约翰公司（第二版）": (9, "18xx 入门首选，股票操作比想象中轻，铁路建造节奏清晰，两人也能开起来。"),
        "阿纳克遗迹": (8, None),
        "行动代号": (8, None),
    },
    "米宝收纳控": {
        "方舟动物园": (9, "卡牌按颜色分四堆、动物标记按体型分三格，摆桌时间从 15 分钟压到 6 分钟，重策都该这么收纳。"),
        "七大奇迹：对决": (9, "两人局节奏极好，军事线不用堆满，留 1-2 格当威慑就能逼对方分心，性价比很高。"),
        "精灵岛": (9, "合作抗压感很强，不同精灵能力差异明显，重开性比想象中高，配件也扎实。"),
        "展翅翱翔": (9, None),
        "花砖物语": (8, None),
        "卡卡颂": (8, None),
        "勃根地城堡": (9, None),
        "斋普尔": (7, None),
        "圣托里尼": (8, None),
        "璀璨宝石": (8, None),
        "幽港迷城：雄狮蛮颚": (8, "比本体轻不少，收纳也友好，适合固定四人小队开短战役。"),
        "富饶之城": (7, None),
        "瘟疫危机": (8, None),
        "七大奇迹": (8, None),
        "情书": (7, None),
    },
    "周末开团": {
        "茂林源记": (9, "四人固定「猫+鸟+联盟+商会」最均衡，商会进局慢刚好压住联盟中期滚雪球，拉扯比默认配置好看。"),
        "幽港迷城": (9, "第 8 幕卡了三次，最后发现不是牌组弱，是没利用地形和先手顺序。这游戏本质是读图。"),
        "行动代号": (8, "开团暖场首选，规则两分钟讲完，猜词时的头脑风暴比游戏本身还热闹。"),
        "抵抗组织：阿瓦隆": (8, None),
        "一夜终极狼人": (7, None),
        "BANG! 砰！": (7, None),
        "帝国曙光（第 4 版）": (9, None),
        "马可波罗": (8, None),
        "火爆狂飙：全速前进": (8, None),
        "诡秘庄园": (7, None),
        "工业革命：伯明翰": (9, None),
        "方舟动物园": (8, None),
        "卡坦岛": (7, None),
        "镰刀战争": (8, "美术和版图很抓人，但四人局中期容易变成各自刷分，得有一个人主动去打，不然节奏会散。"),
        "阿纳克遗迹": (8, None),
        "富饶之城": (7, None),
        "幽港迷城：雄狮蛮颚": (8, None),
    },
    "骰子狂人": {
        "殖民火星": (9, "公司卡固定「抽 2 选 1」：既不破坏平衡又照顾新手，强公司出现率也不会被无限拉高，我们桌一直这么玩。"),
        "皇舆争霸": (9, "金币流被诅咒牌打崩过一次就懂了：看到有人起诅咒，优先抢净化或转攻击流，别闷头堆金币。"),
        "圣托里尼": (8, "神明能力让每局思路都不同，规则十分钟讲完但决策不浅，两人局常备。"),
        "三国杀": (7, None),
        "东京之王": (7, None),
        "政变疑云": (7, None),
        "Tichu（地主）": (8, None),
        "量子": (7, None),
        "石器时代2.0：史前部落": (7, None),
        "末日决战": (8, None),
        "茂林源记": (9, None),
        "璀璨宝石": (7, None),
        "工业革命：伯明翰": (9, None),
        "瘟疫危机": (7, None),
        "约翰公司（第二版）": (9, None),
        "富饶之城": (7, None),
        "幽港迷城：雄狮蛮颚": (8, None),
    },
    "新手求带": {
        "卡卡颂": (8, "第一次玩只顾铺城市，农民一块没放，结果被农民流反超。新手局中期就该开始占田，晚了真的追不回。"),
        "花砖物语": (8, "负分收场过一次就懂了：优先拿能立刻上墙的颜色，别为了凑数量拿没位置的砖。"),
        "情书": (7, "十几张牌的小游戏，等人时开一局刚好，运气成分不低但节奏轻快。"),
        "卡坦岛": (7, None),
        "璀璨宝石": (8, None),
        "王国米诺": (7, None),
        "花火": (9, None),
        "七大奇迹": (8, None),
        "行动代号：双人": (8, None),
        "七大奇迹：对决": (8, None),
        "镰刀战争": (7, "第一次玩被规则量吓到，实际上手后行动选择很直观，就是容易忘掉自己的目标，新手最好先约定打几轮。"),
        "瘟疫危机": (7, None),
        "富饶之城": (7, None),
        "阿纳克遗迹": (7, None),
    },
}

# 短评收到的点赞（点赞人从其余玩家中取，按顺序）
LIKES = {
    ("桌游老张", "工业革命：伯明翰"): ["骰子狂人", "周末开团", "米宝收纳控"],
    ("米宝收纳控", "方舟动物园"): ["新手求带", "周末开团"],
    ("周末开团", "茂林源记"): ["桌游老张", "骰子狂人"],
    ("骰子狂人", "殖民火星"): ["新手求带"],
    ("新手求带", "卡卡颂"): ["米宝收纳控", "桌游老张"],
    ("骰子狂人", "皇舆争霸"): ["桌游老张"],
    ("周末开团", "幽港迷城"): ["骰子狂人"],
    ("桌游老张", "瘟疫危机"): ["新手求带", "米宝收纳控"],
    ("桌游老张", "约翰公司（第二版）"): ["骰子狂人"],
    ("米宝收纳控", "幽港迷城：雄狮蛮颚"): ["周末开团"],
    ("周末开团", "镰刀战争"): ["桌游老张", "骰子狂人"],
    ("新手求带", "镰刀战争"): ["周末开团", "桌游老张"],
}


async def main() -> None:
    async with SessionLocal() as session:
        users = {
            u.username: u
            for u in (
                await session.execute(select(User).where(User.username.in_(list(REVIEWS))))
            ).scalars().all()
        }
        missing_users = [n for n in REVIEWS if n not in users]
        if missing_users:
            print(f"缺少玩家账号：{missing_users}（请先运行 seed_community_refresh.py）")
            return

        games = {
            g.name: g.id for g in (await session.execute(select(BoardGame))).scalars().all()
        }

        if RESET:
            ids = [u.id for u in users.values()]
            await session.execute(delete(ReviewLike).where(ReviewLike.user_id.in_(ids)))
            await session.execute(delete(Review).where(Review.user_id.in_(ids)))
            await session.commit()
            print("已清空这 5 位玩家的评分与点赞")

        # 时间线：近 30 天内按顺序铺开，避免全部同一时刻
        slots: list[datetime] = []
        base = datetime.now() - timedelta(days=30)
        for i in range(60):
            slots.append(base + timedelta(days=i * 11 // 60, hours=(i * 7) % 12))

        created = skipped = 0
        idx = 0
        for username, entries in REVIEWS.items():
            user = users[username]
            for game_name, (rating, content) in entries.items():
                gid = games.get(game_name)
                if gid is None:
                    print(f"  ! 跳过（桌游不存在）：{game_name}")
                    continue
                exists = (
                    await session.execute(
                        select(Review).where(Review.user_id == user.id, Review.game_id == gid)
                    )
                ).scalar_one_or_none()
                if exists:
                    skipped += 1
                    continue
                review = Review(
                    user_id=user.id,
                    game_id=gid,
                    rating=rating,
                    content=content,
                    like_count=0,
                    created_at=slots[idx % len(slots)],
                )
                session.add(review)
                await session.flush()
                idx += 1

                likers = LIKES.get((username, game_name), [])
                for liker in likers:
                    lu = users.get(liker)
                    if lu is None:
                        continue
                    session.add(ReviewLike(review_id=review.id, user_id=lu.id))
                review.like_count = len(likers)
                created += 1

            # 玩过的游戏补「玩过」标记，另外随机少量「想玩」
            for game_name in entries:
                gid = games.get(game_name)
                if gid is None:
                    continue
                marked = (
                    await session.execute(
                        select(Collection).where(
                            Collection.user_id == user.id, Collection.game_id == gid
                        )
                    )
                ).scalar_one_or_none()
                if marked is None:
                    session.add(Collection(user_id=user.id, game_id=gid, status="played"))
        await session.commit()

        # 按真实评测重算每款桌游的均分与评分人数
        rows = (await session.execute(select(BoardGame))).scalars().all()
        for game in rows:
            avg, cnt = (
                await session.execute(
                    select(func.avg(Review.rating), func.count(Review.id)).where(
                        Review.game_id == game.id
                    )
                )
            ).first()
            game.avg_rating = round(float(avg), 2) if avg is not None else 0.0
            game.rating_count = int(cnt or 0)
        await session.commit()

        top = (
            await session.execute(
                select(BoardGame.name, BoardGame.avg_rating, BoardGame.rating_count)
                .where(BoardGame.rating_count > 0)
                .order_by(BoardGame.avg_rating.desc(), BoardGame.rating_count.desc())
                .limit(8)
            )
        ).all()
        print(f"评测：新增 {created} 条，跳过已存在 {skipped} 条")
        print("当前评分榜：")
        for n, a, c in top:
            print(f"  {n:<18s} {a:.1f} 分（{c} 人）")


if __name__ == "__main__":
    asyncio.run(main())
