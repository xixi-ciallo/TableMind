import client from './client';

/** 榜单定义（由后端按站内真实数据生成，含各榜可参与数量） */
export interface RankingBoard {
  id: string;
  label: string;
  group: string;
  description: string;
  game_count: number;
}

/** 榜单里的一行 */
export interface RankingRow {
  rank: number;
  game_id: number;
  name: string;
  name_en: string | null;
  cover_image: string | null;
  avg_rating: number;
  rating_count: number;
  min_players: number | null;
  max_players: number | null;
  play_time_minutes: number | null;
  year_published: number | null;
  categories: string[];
  mechanics: string[];
}

export interface RankingResult {
  board: string;
  label: string;
  description: string;
  min_ratings: number;
  total: number;
  rows: RankingRow[];
}

/** 可用榜单列表（综合 / 人数 / 时长 / 年代 / 分类 / 机制） */
export async function fetchRankingBoards(): Promise<RankingBoard[]> {
  const { data } = await client.get<RankingBoard[]>('/rankings/boards');
  return data;
}

/** 某个榜单的排名数据，排序依据为本站玩家评分 */
export async function fetchRanking(
  board: string,
  limit = 20,
  minRatings?: number,
): Promise<RankingResult> {
  const params: Record<string, string | number> = { board, limit };
  if (minRatings) params.min_ratings = minRatings;
  const { data } = await client.get<RankingResult>('/rankings', { params });
  return data;
}
