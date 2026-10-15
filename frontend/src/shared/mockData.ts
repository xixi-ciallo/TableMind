import type { Post } from './types';

/**
 * 社区帖子数据。
 *
 * 说明：社区发帖/评论功能尚未接入后端接口，此处是**界面演示用的占位内容**，
 * 仅在社区页展示，不会出现在桌游详情页、排行榜等任何需要展示真实数据的页面。
 * 桌游本身的数据一律来自 gameLibrary.ts（真实且逐条可溯源）。
 */
export const mockPosts: Post[] = [
  {
    id: 1,
    user_id: 2,
    game_id: null,
    title: '社区功能内测中',
    content:
      '这里将展示玩家真实发布的帖子与评测。当前社区发帖接口尚未接入，页面上看到的是版式演示内容。',
    created_at: '2026-10-05T10:00:00',
  },
  {
    id: 2,
    user_id: 3,
    game_id: null,
    title: '欢迎来桌游库挑游戏',
    content: '桌游库中的 30 款游戏资料全部来自 BoardGameGeek 公开数据，可在详情页逐条核对来源。',
    created_at: '2026-10-05T09:30:00',
  },
  {
    id: 3,
    user_id: 4,
    game_id: null,
    title: '教学视频怎么看？',
    content: '在任意桌游详情页的「教学视频」板块点击卡片，会先弹出确认提示，确认后才会跳转到哔哩哔哩。',
    created_at: '2026-10-05T09:00:00',
  },
];
