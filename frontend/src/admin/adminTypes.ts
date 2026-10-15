/**
 * 管理端数据类型
 *
 * 全部字段严格对齐后端 `app/schemas/*.py`（以 /openapi.json 为准），
 * 不存在的字段不臆造：后端未返回时以 null / undefined 表达，页面显示「暂无数据」。
 */
import type { User } from '../shared/types';

/** 单日序列点 GET /api/admin/stats/daily —— DailyPoint */
export interface AdminDailyPoint {
  date: string;
  users: number;
  reviews: number;
  posts: number;
  ai_calls: number;
}

/** 供图表消费的序列值 */
export interface AdminSeriesPoint {
  date: string;
  values: {
    users: number;
    reviews: number;
    posts: number;
    ai_calls: number;
  };
}

/** 评分榜中的桌游点 */
export interface AdminGamePoint {
  id: number;
  name: string;
  cover_image?: string | null;
  avg_rating: number;
  rating_count: number;
}

/** 评分分布点 */
export interface AdminRatingPoint {
  rating: number;
  count: number;
}

/** 标签使用量点 */
export interface AdminTagPoint {
  name: string;
  type: string;
  usage_count: number;
}

/** GET /api/admin/stats —— StatsOut */
export interface AdminStats {
  user_count: number | null;
  game_count: number | null;
  review_count: number | null;
  post_count: number | null;
  ai_call_count: number | null;
  days?: number;
  series?: AdminSeriesPoint[];
  top_games?: AdminGamePoint[];
  rating_distribution?: AdminRatingPoint[];
  tag_usage?: AdminTagPoint[];
}

/** GET /api/admin/games —— AdminGameOut（POST/PUT 同样返回该结构，含后台专属 admin_note） */
export interface AdminGame {
  id: number;
  name: string;
  name_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  cover_image?: string | null;
  min_players?: number | null;
  max_players?: number | null;
  play_time_minutes?: number | null;
  min_age?: number | null;
  complexity?: number | null;
  categories?: string[] | null;
  mechanics?: string[] | null;
  publisher?: string | null;
  year_published?: number | null;
  avg_rating?: number | null;
  rating_count?: number | null;
  bgg_id?: number | null;
  bgg_url?: string | null;
  designers?: string[] | null;
  artists?: string[] | null;
  min_playtime?: number | null;
  max_playtime?: number | null;
  admin_note?: string | null;
  /** 已入库的规则说明书切片数，0 表示尚无说明书 */
  rule_chunk_count?: number | null;
}

/** GameCreate / GameUpdate 的请求体（GameUpdate 下所有字段均可选） */
export interface AdminGamePayload {
  name?: string;
  name_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  cover_image?: string | null;
  min_players?: number | null;
  max_players?: number | null;
  play_time_minutes?: number | null;
  min_age?: number | null;
  complexity?: number | null;
  categories?: string[];
  mechanics?: string[];
  publisher?: string | null;
  year_published?: number | null;
  bgg_id?: number | null;
  bgg_url?: string | null;
  designers?: string[];
  artists?: string[];
  min_playtime?: number | null;
  max_playtime?: number | null;
  admin_note?: string | null;
}

/** GET /api/admin/games —— GameListOut（带真实总数，分页可显示准确页码） */
export interface AdminGameListResult {
  total: number;
  items: AdminGame[];
  incomplete: number;
  /** 透出给列表 hook 的聚合值（待补全数量） */
  extra?: Record<string, number>;
}

/** GET /api/admin/stats/completeness —— 单款桌游的资料完整度体检 */
export interface AdminGameCompleteness {
  id: number;
  name: string;
  score: number;
  missing: string[];
}

/** GET /api/admin/users —— UserListOut（带真实总数与禁用账号数） */
export interface AdminUserListResult {
  total: number;
  items: User[];
  disabled: number;
}

/** GET /api/admin/users/{id} —— 用户详情，附站内真实产出条数 */
export interface AdminUserDetail extends User {
  review_count: number;
  post_count: number;
  collection_count: number;
}

export type AdminTagType = 'category' | 'mechanic';

/** GET /api/admin/tags —— TagOut（后端附带 usage_count：被多少款桌游引用） */
export interface AdminTag {
  id: number;
  name: string;
  type: string;
  usage_count?: number;
}

/** POST /api/admin/tags/sync —— TagSyncOut */
export interface AdminTagSyncResult {
  created?: number;
  updated?: number;
  detail?: string;
}

/** TagCreate 请求体 */
export interface AdminTagPayload {
  name: string;
  type: AdminTagType;
}

/** GET /api/admin/moderation/reviews（后端已 join 出 username / game_name） */
export interface AdminReview {
  id: number;
  user_id?: number | null;
  username?: string | null;
  game_id?: number | null;
  game_name?: string | null;
  rating?: number | null;
  content?: string | null;
  created_at?: string | null;
}

/** GET /api/admin/moderation/posts */
export interface AdminPost {
  id: number;
  user_id?: number | null;
  username?: string | null;
  game_id?: number | null;
  game_name?: string | null;
  title?: string | null;
  content?: string | null;
  created_at?: string | null;
}

/** GET /api/admin/moderation/comments */
export interface AdminComment {
  id: number;
  post_id?: number | null;
  post_title?: string | null;
  user_id?: number | null;
  username?: string | null;
  parent_id?: number | null;
  content?: string | null;
  created_at?: string | null;
}

export type ModerationKind = 'reviews' | 'posts' | 'comments';

/**
 * 规则书（原始说明书文件）与规则文档（切片文本 + 向量）在数据层是两回事：
 * - 规则书 rule_books：PDF / 逐页图片，保留排版插图，供前台原样翻阅；
 * - 规则文档 rule_documents：从规则书抽出的文本切片，只服务 RAG 检索。
 */
export interface AdminRuleBook {
  id: number;
  game_id: number;
  game_name?: string | null;
  title: string;
  /** pdf | images */
  file_type: string;
  file_path: string;
  url: string;
  page_count?: number | null;
  language?: string;
  is_official?: boolean;
  source?: string | null;
  source_url?: string | null;
  chunk_count?: number;
  vectorized?: boolean;
  /** 图片型规则书的页文件名（按顺序） */
  pages?: string[] | null;
  created_at?: string | null;
}

export interface RuleBookBuildResult {
  detail?: string;
  rule_book_id?: number;
  added?: number;
  chunk_count?: number;
  vectorized?: boolean;
  source?: string;
}

/** GET /api/admin/games/{game_id}/rule-docs —— RuleDocStatus */
export interface RuleDocStatus {
  game_id: number;
  chunk_count: number | null;
  vectorized: boolean | null;
}

/** GET /api/admin/rule-docs —— 按桌游聚合的总览，供首屏直接看到库里有什么 */
export interface RuleDocSummary {
  game_id: number;
  game_name: string | null;
  chunk_count: number | null;
  vectorized: boolean | null;
}

/** GET /api/admin/games/{id}/rule-docs/chunks —— 切片内容预览 */
export interface RuleChunkItem {
  chunk_index: number;
  content: string;
  char_count: number | null;
  has_embedding: boolean | null;
}

/** 通用响应：{"detail": "..."} */
export interface ApiMessage {
  detail?: string;
}

/** PUT /api/admin/users/{user_id}/status 的响应（占位实现返回 id + is_active） */
export interface UserStatusResult {
  id?: number;
  is_active?: boolean;
  detail?: string;
}

/** POST /api/admin/games/{game_id}/rule-docs 的响应 */
export interface RuleDocUploadResult {
  game_id?: number;
  chunk_count?: number;
  /** 本次上传新增的切片数（追加模式下小于总数） */
  added?: number;
  vectorized?: boolean;
  mode?: 'replace' | 'append' | string;
  /** 解析来源：pdf / text / image-ocr */
  source?: string;
  detail?: string;
}
