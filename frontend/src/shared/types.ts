// 与 DESIGN.md 第五节数据库表结构对应的 TS 类型

export type UserRole = 'user' | 'admin';

export interface User {
  id: number;
  username: string;
  /** 注册凭证为手机号（唯一） */
  phone: string;
  role: UserRole;
  avatar?: string | null;
  /** 个人简介（个人中心展示与编辑） */
  bio?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface BoardGame {
  id: number;
  name: string;
  name_en?: string | null;
  description?: string | null;
  cover_image?: string | null;
  min_players: number;
  max_players: number;
  /** 官方给出区间时取区间下限用于筛选；展示文案见 play_time_text */
  play_time_minutes: number | null;
  min_age: number;
  /** 官方来源未提供的字段一律为 null，页面显示“暂无数据”，不使用估算值 */
  complexity: number | null; // 1~5
  categories: string[];
  mechanics: string[];
  publisher?: string | null;
  year_published?: number | null;
  avg_rating: number | null;
  rating_count: number | null;
  /** 以下为真实数据层扩展字段 */
  slug?: string;
  designers?: string[];
  play_time_text?: string;
}

export type TagType = 'category' | 'mechanic';

export interface GameTag {
  id: number;
  name: string;
  type: TagType;
}

export interface Review {
  id: number;
  user_id: number;
  game_id: number;
  rating: number; // 1~10
  content: string;
  like_count: number;
  created_at: string;
}

export interface Post {
  id: number;
  user_id: number;
  game_id?: number | null;
  title: string;
  content: string;
  created_at: string;
}

export interface Comment {
  id: number;
  post_id: number;
  user_id: number;
  parent_id?: number | null;
  content: string;
  created_at: string;
}

export type CollectionStatus = 'want' | 'played' | 'owned';

export interface Collection {
  id: number;
  user_id: number;
  game_id: number;
  status: CollectionStatus;
  created_at: string;
}

export interface RuleDocument {
  id: number;
  game_id: number;
  chunk_index: number;
  content: string;
}

export interface ChatSession {
  id: number;
  user_id: number;
  title?: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}
