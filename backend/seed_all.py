# -*- coding: utf-8 -*-
"""一键初始化数据：按依赖顺序串联全部种子脚本，失败即停。

用法（在 backend 目录）：
    python seed_all.py                     # 管理员 + 桌游 + 社区 + 评分 + 官方资讯
    python seed_all.py --with-rulebooks    # 追加规则语料（逐页 OCR + 向量化，耗时长且消耗额度）

等价于手动按序执行：
    seed_admin.py -> seed_catalog.py -> seed_community_refresh.py
    -> seed_reviews.py -> seed_official_news.py [-> seed_rulebooks.py]

各脚本自身幂等（seed_community_refresh.py 会先清空社区表再重灌）。
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

STEPS = [
    ("管理员账号", "seed_admin.py"),
    ("桌游目录（47 款）", "seed_catalog.py"),
    ("社区（先清空再重灌）", "seed_community_refresh.py"),
    ("评分评测（依赖社区玩家账号）", "seed_reviews.py"),
    ("官方资讯帖", "seed_official_news.py"),
]


def run_step(label: str, script: str) -> bool:
    print(f"\n{'=' * 50}\n>>> [{label}] python {script}\n{'=' * 50}")
    ret = subprocess.run([sys.executable, str(HERE / script)], cwd=str(HERE)).returncode
    if ret != 0:
        print(f"\n[FAILED] {script} 退出码 {ret}，已停止后续步骤。"
              f"请修复后重跑（各脚本幂等，重跑安全）。")
        return False
    return True


def main() -> int:
    steps = STEPS[:]
    if "--with-rulebooks" in sys.argv:
        steps.append(("规则语料（OCR + 向量化，耗时长）", "seed_rulebooks.py"))
    else:
        print("提示：未包含规则语料（AI 问答需要）。需要时加 --with-rulebooks 或单独执行 seed_rulebooks.py")

    print(f"TableMind 数据初始化，共 {len(steps)} 步")
    for label, script in steps:
        if not run_step(label, script):
            return 1
    print(f"\n{'=' * 50}\n[完成] 全部 {len(steps)} 步执行成功。"
          "可运行 python check_env.py 复核环境，然后启动后端与前端。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
