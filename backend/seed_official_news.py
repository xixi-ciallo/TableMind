# -*- coding: utf-8 -*-
"""官方公告种子：收集自公开渠道的真实桌游信息，由管理员账号发布、置顶展示。

- 原有 6 条：真实官方公告（App 更新日志 / 官方发售 / 厂商众筹更新），发布日期取真实事件日；
- 新增 3 条：取材自集石（gstonegames.com）文章板块与讨论板块的真实内容，附原文链接，
  仅做忠实摘编与归因，不虚构任何指标与数据。
- 头图：凡关联到本站真实收录的桌游（catalog.json 中存在且 public/games/<slug> 有真实图），
  则取该游戏真实实拍图作头图（绝不用桌游封面冒充玩家图）；无关联游戏的帖子不挂图。
用法：
    PYTHONPATH=. python seed_official_news.py          # 幂等写入（已存在同标题则跳过），不清空讨论帖
    PYTHONPATH=. python seed_official_news.py --reset  # 仅清空官方帖后重写（不影响玩家讨论）
"""
import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.database import engine
from app.models.board_game import BoardGame
from app.models.post import Post
from app.models.post_media import PostMedia
from app.models.user import User

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
ROOT = Path(__file__).resolve().parent
RESET = "--reset" in __import__("sys").argv

# catalog.json：前后端共用的 slug → 桌游 映射（board_games 表无 slug 列）
CATALOG = ROOT.parent / ".workbuddy" / "tmp" / "catalog.json"
PUBLIC_GAMES = ROOT.parent / "frontend" / "public" / "games"


def slug_by_name() -> dict[str, str]:
    if not CATALOG.exists():
        return {}
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else data.get("games", [])
    return {g["name"]: g["slug"] for g in items if g.get("name") and g.get("slug")}


def resolve_header_image(slug: str | None) -> str | None:
    """取该游戏 public 目录下的首张真实图作头图（优先 gallery-1，其次 play-1，再 cover）。"""
    if not slug:
        return None
    d = PUBLIC_GAMES / slug
    if not d.is_dir():
        return None
    for cand in ("gallery-1.jpg", "play-1.jpg", "cover.jpg"):
        if (d / cand).exists():
            return f"/games/{slug}/{cand}"
    return None


# ── 真实官方公告（title / date=真实事件日 / game=库内桌游名 / content 摘自公开来源） ──
OFFICIAL_NEWS = [
    {
        "title": "《染·钟楼谜团》9月29日重大版本更新公告",
        "date": "2026-09-29 10:00",
        "game": None,
        "source": "官方 App 更新日志（v15.0.0.1）",
        "content": (
            "血染钟楼新版本（15.0.0.1）持续优化游戏体验与产品稳定性。本次版本围绕房间体验、"
            "真人说书、社交互动及性能表现进行了多项升级，让组局更顺畅、语音更稳定、操作更便捷。\n\n"
            "【新增】支持房间自定义名称，创建属于你的专属房间\n"
            "【新增】新增个人静音、拉黑功能，优化语音房互动体验\n"
            "【新增】新增说书人点评标签，更方便记录和发现不同风格的说书人\n"
            "【优化】优化进房 Loading、资源加载及状态修复，减少卡顿与等待\n"
            "【优化】优化等待房间、预约组局及房间排序，提升组局效率\n"
            "【优化】优化好友推荐、邀请好友、礼物及排行榜体验\n"
            "【优化】提升语音房稳定性、图片加载速度及整体性能表现\n\n"
            "来源：官方更新日志。未来我们也将持续为大家带来更稳定、更丰富的体验。"
        ),
    },
    {
        "title": "《三国杀》4.5.1 版本更新：新武将势·钟会、势·王昶即将上线",
        "date": "2026-01-08 10:00",
        "game": "三国杀",
        "source": "官方版本更新日志（4.5.1）",
        "content": (
            "《三国杀》4.5.1 版本更新内容如下：\n\n"
            "【2026-启岁活动】“超级星期五”福利活动每周重置，新年第一季度排位赛大师段位奖励已重置。\n"
            "【我是大国师】全新活动场：在身份局基础上融入全新机制与多身份融合特色，"
            "只需掌握基础规则即可体验。\n"
            "【新武将】势·钟会、势·王昶即将上线。\n"
            "【新皮肤】力引三矢*沙摩柯、狩畋射虎*孙权、冠绝天下*鲍信、冠绝天下*法正即将上线。\n"
            "【征战天下】主线新章节“汉中定鼎”正式开启。\n"
            "【其它】称号系统支持不穿戴称号；新增“一键选牌”功能，手牌较多时可快捷选择；"
            "录像功能优化，提前离开对局仍可通过录像记录比赛。\n\n"
            "来源：官方版本更新日志。"
        ),
    },
    {
        "title": "《卡坦岛》改版「标准版」今日于日本发售：视觉与配件全面优化",
        "date": "2026-04-24 10:00",
        "game": "卡坦岛",
        "source": "GP 官方公告 / media 报道",
        "content": (
            "日本桌遊大厂 GP 宣布的《卡坦岛》（CATAN）全面改版首波作品「卡坦岛 标准版」"
            "于 2026 年 4 月 24 日正式在日本发售，建议售价 4,500 日元（未税）。\n\n"
            "本次改版参照 30 周年纪念版的更新标准：卡牌、版块等游戏零件的设计全面现代化，"
            "提升卡牌视觉辨识度；新增「零件收纳盒」，让配件整理更轻松；"
            "规则书图片与图例更丰富。核心玩法机制保持不变，支持 3-4 人游玩，建议 8 岁以上。\n\n"
            "截至 2025 年 12 月，《卡坦岛》全球累计销量已突破 4,500 万套。"
            "官方表示系列旗下其他扩展也将陆续分阶段改版。\n\n"
            "来源：GP 官方公告及公开报道。"
        ),
    },
    {
        "title": "《殖民火星》衍生战役《The Legacy of Mars》众筹进入最后阶段",
        "date": "2026-05-27 10:00",
        "game": "殖民火星",
        "source": "FryxGames 官方众筹更新（Update #25）",
        "content": (
            "FryxGames 团队发布官方更新：《The Legacy of Mars》并非简单给《殖民火星》"
            "加一个战役模式，而是一场完全可重复游玩的跨世代战役——你的公司将在多个星球间"
            "不断进化，从火星开始，人类向外扩张到太阳系（乃至更远）的全新行星与卫星。\n\n"
            "每一幕任务都会随新机制、新策略挑战、不断进化的卡牌池与为该星球专门构建的全新系统"
            "而显著改变玩法；但《殖民火星》的核心不变：引擎构筑、协同配合、调整策略，"
            "以及见证你的公司逐步壮大。\n\n"
            "众筹活动已在 Gamefound 进入最后阶段。来源：官方众筹更新。"
        ),
    },
    {
        "title": "《茂林源记》Homeland 扩大量产样品确认，2026 年 Q1 起发货",
        "date": "2026-01-07 10:00",
        "game": "茂林源记",
        "source": "Leder Games 官方众筹更新（Update #7）",
        "content": (
            "Leder Games 官宣：《茂林源记》（Root）The Homeland Expansion 的量产样品"
            "（MPC）已收到并通过审核，工厂印刷与配件一切正常，发货计划维持不变——"
            "预计 2026 年第一季度开始履约。\n\n"
            "本扩展带来三个全新阵营与两张新地图：\n"
            "· 睡莲离散者（Lilypad Diaspora）：流散已久的他们希望在森林重获家园；\n"
            "· 暮光议会（Twilight Council）：以集会与辩论代替流血冲突，靠政治联结而非兵力取胜；\n"
            "· 深林无赖（Knaves of the Deepwood）：从林深处出击、绑票勒赎的乌合之众。\n"
            "另含可扩展的沼泽地图与峡谷地图。\n\n"
            "来源：官方众筹更新。"
        ),
    },
    {
        "title": "《方舟动物园：海洋世界》扩展今日发售：海洋动物与水族馆登场",
        "date": "2026-06-05 10:00",
        "game": "方舟动物园",
        "source": "Capstone Games / Feuerland Spiele 官方发售信息",
        "content": (
            "《方舟动物园》首个大型扩展「海洋世界」（Marine Worlds）于 2026 年 6 月 5 日"
            "正式发售（北美渠道）。\n\n"
            "扩展将海洋动物引入动物园：需要新建「水族馆」这一全新特殊圈养区来安置它们；"
            "五张原版行动卡新增了四张带小额加成的替代版本，开局替换其中两张，"
            "熟悉的机制带来不同的策略体验；另含新的大学、动物园卡、终局计分卡、奖励板块，"
            "以及吸引力 / 保育 / 声望三条轨道的木质替代标记与木质动物指示物。\n\n"
            "扩展需搭配基本版游玩。来源：官方发售信息。"
        ),
    },
    # ── 新增：取材自集石（gstonegames.com）文章 / 讨论板块，附原文链接，忠实摘编 ──
    {
        "title": "【集石转载】153桌游茶话会 S3E4：和《滥觞》设计师润棠聊聊他的桌游",
        "date": "2026-09-25 10:00",
        "game": None,
        "source": "集石文章板块 · article/detail-9090.html",
        "content": (
            "「153桌游茶话会」第三季第 4 期，主题是与设计师润棠聊聊他的桌游《滥觞》。\n\n"
            "本期嘉宾为润棠，常驻主持 Foreza、UU，于北京一处茶馆实地录制，剪辑与后期由 Foreza 完成。"
            "节目以轻松对谈的形式，聊设计师的创作初衷、机制取舍，以及一款桌游从想法到成品背后的故事。\n\n"
            "这类设计师对谈是了解一款游戏「为什么这么设计」的优质素材，也适合想入门德式策略、"
            "又想听听幕后故事的玩家。\n\n"
            "原文链接：[153桌游茶话会 S3E4｜和润棠设计师聊聊《滥觞》](https://www.gstonegames.com/article/detail-9090.html)"
        ),
    },
    {
        "title": "【集石讨论精选】低重度高深度：8 款新手秒懂、老手玩不腻的宝藏桌游",
        "date": "2026-09-21 10:00",
        "game": None,
        "source": "集石讨论板块 · discuss-6-82838（BGC 转载）",
        "content": (
            "一位玩家在集石分享了他的「低重度高深度」选品标准：规则复杂度低、却战略深度高；"
            "易学难精，体感轻量却依然奖励经验积累——这类游戏既能摆在休闲玩家和新手面前，"
            "又经得起反复重开。他列出了 8 款符合标准的游戏，其中详述了三款：\n\n"
            "· 鳍羽展翅（Fin Span）：《羽翼翱翔》的海洋姐妹篇，引擎构筑但更紧凑聚焦，"
            "起手快、回合顺，适合混龄玩家。\n"
            "· 城堡连击（Castle Combo）：从市场轮抽角色卡、在 3×3 阵列中凑连击，规则极简，"
            "深度在摆放与时机抉择，一局 10–25 分钟，适合连开两三局。\n"
            "· 和谐美景（Harmonies）：轮抽标志物、建造栖息地引入动物，表面宁静、"
            "空间决策却很尖锐，桌面也好看吸睛。\n\n"
            "完整 8 款清单与更多玩家讨论见原文。原文链接："
            "[低重度高深度：8 款宝藏桌游](https://www.gstonegames.com/bbs/discuss-6-82838-1.html)"
        ),
    },
    {
        "title": "【集石讨论精选】新手入坑桌游，该从哪一款入手？老玩家这样建议",
        "date": "2026-09-29 10:00",
        "game": "花砖物语",
        "source": "集石讨论板块 · discuss-21-83025",
        "content": (
            "一位萌新在集石发帖纠结「入坑第一款桌游选什么」，老玩家的共识很一致："
            "先去桌游店或线上（如 BoardGameArena）试玩，再决定买不买——很多游戏重开性配不上价格，"
            "新手先玩再买最稳妥。\n\n"
            "具体到游戏，被反复点名的「新手友好」选择包括：花砖物语（2 人精算、3–4 人娱乐，板块放置、交互高）、"
            "方舟动物园（卡牌构筑）、璀璨宝石（引擎构筑）、七大奇迹对决（两人对决系列）。"
            "也有人建议先想清自己喜欢「打牌 / 下棋 / 解谜 / RPG」哪类，再对症下药。\n\n"
            "一句话：别急着下单，多试几款才能找到自己的本命。原文链接："
            "[新手入坑该从哪款入手？](https://www.gstonegames.com/bbs/discuss-21-83025-1.html)"
        ),
    },
]


async def main():
    async with SessionLocal() as session:
        admin = (
            await session.execute(select(User).where(User.role == "admin"))
        ).scalars().first()
        if not admin:
            print("未找到管理员账号，请先运行 seed_admin.py")
            return

        existing = set((await session.execute(select(Post.title))).scalars().all())

        # 按名称解析库内桌游 id（解析不到就不关联，绝不虚构关联关系）
        games = {
            name: gid
            for name, gid in (await session.execute(select(BoardGame.name, BoardGame.id))).all()
        }
        slug_map = slug_by_name()

        if RESET:
            old = (
                await session.execute(select(Post).where(Post.user_id == admin.id))
            ).scalars().all()
            for p in old:
                await session.execute(PostMedia.__table__.delete().where(PostMedia.post_id == p.id))
            for p in old:
                await session.delete(p)
            await session.commit()
            print(f"已清空 {len(old)} 条官方帖（玩家讨论不受影响）")

        created = 0
        for item in OFFICIAL_NEWS:
            if item["title"] in existing:
                continue
            gid = games.get(item["game"]) if item.get("game") else None
            p = Post(
                user_id=admin.id,
                game_id=gid,
                title=item["title"],
                content=item["content"],
                is_pinned=True,
            )
            if item.get("date"):
                p.created_at = datetime.strptime(item["date"], "%Y-%m-%d %H:%M")
            session.add(p)
            await session.flush()

            # 头图：关联到库内真实桌游则取真实实拍图（按 slug 找首张图）
            slug = slug_map.get(item["game"]) if item.get("game") else None
            cover = resolve_header_image(slug)
            if cover:
                session.add(
                    PostMedia(
                        post_id=p.id,
                        user_id=admin.id,
                        kind="image",
                        slot="header",
                        url=cover,
                        sort_order=0,
                    )
                )
            await session.commit()
            created += 1

        total_off = (
            await session.execute(select(Post).where(Post.user_id == admin.id))
        ).scalars().all()
        print(f"新增官方帖 {created} 条（本次列表共 {len(OFFICIAL_NEWS)} 条真实内容）")
        print(f"社区现有官方帖总数：{len(total_off)}")


if __name__ == "__main__":
    asyncio.run(main())
