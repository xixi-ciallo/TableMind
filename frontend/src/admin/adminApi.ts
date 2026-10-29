/**
 * 管理端接口层
 *
 * 复用 shared/api/client（已配 baseURL=/api 且自动携带 JWT），不在 shared 目录新增文件。
 * 全部路径以 /openapi.json 实测契约为准：
 * - GET /api/admin/games 不存在，列表统一走 GET /api/games
 * - PUT /api/admin/users/{id}/status 的 is_active 是 **query 参数**（非请求体）
 * - 删除类接口返回 {"detail": "..."}
 */
import client from '../shared/api/client';
import type { User } from '../shared/types';
import type {
  AdminGame,
  AdminGameCompleteness,
  AdminGameListResult,
  AdminGamePayload,
  AdminUserDetail,
  AdminUserListResult,
  AdminGamePoint,
  AdminRatingPoint,
  AdminRuleBook,
  AdminSeriesPoint,
  AdminStats,
  EvalCase,
  EvalCasePayload,
  EvalRun,
  EvalRunDetail,
  RuleBookBuildResult,
  AdminTag,
  AdminTagPayload,
  AdminTagPoint,
  AdminTagSyncResult,
  AdminTagType,
  ApiMessage,
  ConfigAuditItem,
  ConfigValue,
  RuleChunkItem,
  RuleDocStatus,
  RuleDocSummary,
  RuleDocUploadResult,
  RuntimeConfigItem,
  UserStatusResult,
} from './adminTypes';
import type { ModerationKind } from './adminTypes';

/** 把后端错误（含 FastAPI 校验错误数组）转成可直接展示的中文文案 */
function toMessage(e: unknown, fallback: string): string {
  const err = e as {
    response?: { status?: number; data?: { detail?: unknown } };
    message?: string;
    code?: string;
  };
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    if (first?.msg) return String(first.msg).replace(/^Value error,\s*/, '');
  }
  if (err?.code === 'ECONNABORTED') return '请求超时，请检查网络后重试';
  if (!err?.response) return '无法连接服务器，请确认后端服务已启动';
  if (err?.response?.status === 403) return '没有权限执行该操作（需要管理员角色）';
  return fallback;
}

/** 后端未返回该字段时保持 null，绝不补 0 兜底：页面据此显示「暂无数据」 */
function pickNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 数组字段：后端未返回或类型不符时统一为空数组，不编造样本 */
function pickArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/* ============================ 仪表盘 ============================ */

/** days 决定趋势日轴长度（后端 ge=2 le=60） */
export async function fetchAdminStats(days?: number): Promise<AdminStats> {
  try {
    const { data } = await client.get<Partial<AdminStats>>('/admin/stats', {
      params: { days: days || undefined },
    });
    return {
      user_count: pickNumber(data?.user_count),
      game_count: pickNumber(data?.game_count),
      review_count: pickNumber(data?.review_count),
      post_count: pickNumber(data?.post_count),
      ai_call_count: pickNumber(data?.ai_call_count),
      days: pickNumber(data?.days) ?? undefined,
      series: pickArray<AdminSeriesPoint>(data?.series),
      top_games: pickArray<AdminGamePoint>(data?.top_games),
      rating_distribution: pickArray<AdminRatingPoint>(data?.rating_distribution),
      tag_usage: pickArray<AdminTagPoint>(data?.tag_usage),
    };
  } catch (e) {
    throw new Error(toMessage(e, '获取统计数据失败'));
  }
}

/* ============================ 桌游 ============================ */

export interface GameListParams {
  page: number;
  page_size: number;
  q?: string;
  sort?: string;
  only_incomplete?: boolean;
}

/**
 * 列表走管理端接口 GET /api/admin/games，返回 { total, items, incomplete }。
 * 后台接口带真实总数，分页控件可以显示准确页码与总条数。
 */
export async function fetchAdminGames(
  params: GameListParams,
): Promise<AdminGameListResult> {
  try {
    const { data } = await client.get<Partial<AdminGameListResult>>('/admin/games', {
      params: {
        page: params.page,
        page_size: params.page_size,
        q: params.q || undefined,
        sort: params.sort || undefined,
        only_incomplete: params.only_incomplete || undefined,
      },
    });
    return {
      total: pickNumber(data?.total) ?? 0,
      items: pickArray<AdminGame>(data?.items),
      incomplete: pickNumber(data?.incomplete) ?? 0,
      extra: { incomplete: pickNumber(data?.incomplete) ?? 0 },
    };
  } catch (e) {
    throw new Error(toMessage(e, '获取桌游列表失败'));
  }
}

/** GET /api/admin/stats/completeness —— 资料完整度体检（得分低的排前面） */
export async function fetchGameCompleteness(
  limit = 20,
): Promise<AdminGameCompleteness[]> {
  try {
    const { data } = await client.get<AdminGameCompleteness[]>(
      '/admin/stats/completeness',
      { params: { limit } },
    );
    return pickArray<AdminGameCompleteness>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取资料完整度失败'));
  }
}

export async function createGame(payload: AdminGamePayload): Promise<AdminGame> {
  try {
    const { data } = await client.post<AdminGame>('/admin/games', payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '新增桌游失败'));
  }
}

export async function updateGame(
  gameId: number,
  payload: AdminGamePayload,
): Promise<AdminGame> {
  try {
    const { data } = await client.put<AdminGame>(`/admin/games/${gameId}`, payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '修改桌游失败'));
  }
}

export async function deleteGame(gameId: number): Promise<ApiMessage> {
  try {
    const { data } = await client.delete<ApiMessage>(`/admin/games/${gameId}`);
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除桌游失败'));
  }
}

/* ============================ 标签 ============================ */

export async function fetchTags(type?: AdminTagType): Promise<AdminTag[]> {
  try {
    const { data } = await client.get<AdminTag[]>('/admin/tags', {
      params: { type: type || undefined },
    });
    return pickArray<AdminTag>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取标签列表失败'));
  }
}

/** 从桌游库重新同步标签（POST /api/admin/tags/sync） */
export async function syncTags(): Promise<AdminTagSyncResult> {
  try {
    const { data } = await client.post<AdminTagSyncResult>('/admin/tags/sync');
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '标签同步失败'));
  }
}

export async function createTag(payload: AdminTagPayload): Promise<AdminTag> {
  try {
    const { data } = await client.post<AdminTag>('/admin/tags', payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '新增标签失败'));
  }
}

export async function updateTag(
  tagId: number,
  payload: AdminTagPayload,
): Promise<AdminTag> {
  try {
    const { data } = await client.put<AdminTag>(`/admin/tags/${tagId}`, payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '修改标签失败'));
  }
}

export async function deleteTag(tagId: number): Promise<ApiMessage> {
  try {
    const { data } = await client.delete<ApiMessage>(`/admin/tags/${tagId}`);
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除标签失败'));
  }
}

/* ============================ 用户 ============================ */

export interface UserListParams {
  page: number;
  pageSize: number;
  q?: string;
  role?: string;
}

export async function fetchUsers(params: UserListParams): Promise<AdminUserListResult> {
  try {
    const { data } = await client.get<Partial<AdminUserListResult>>('/admin/users', {
      params: {
        page: params.page,
        page_size: params.pageSize,
        q: params.q || undefined,
        role: params.role || undefined,
      },
    });
    return {
      total: pickNumber(data?.total) ?? 0,
      items: pickArray<User>(data?.items),
      disabled: pickNumber(data?.disabled) ?? 0,
    };
  } catch (e) {
    throw new Error(toMessage(e, '获取用户列表失败'));
  }
}

/** GET /api/admin/users/{id} —— 用户详情（含站内真实产出条数） */
export async function fetchUserDetail(userId: number): Promise<AdminUserDetail> {
  try {
    const { data } = await client.get<AdminUserDetail>(`/admin/users/${userId}`);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '获取用户详情失败'));
  }
}

/** 调整角色：is_active 与 role 均为 query 参数 */
export async function setUserRole(
  userId: number,
  role: string,
): Promise<UserStatusResult> {
  try {
    const { data } = await client.put<UserStatusResult>(
      `/admin/users/${userId}/role`,
      null,
      { params: { role } },
    );
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '调整角色失败'));
  }
}

/** is_active 由后端声明为必填 query 参数，因此走 params 而非请求体 */
export async function setUserStatus(
  userId: number,
  isActive: boolean,
): Promise<UserStatusResult> {
  try {
    const { data } = await client.put<UserStatusResult>(
      `/admin/users/${userId}/status`,
      null,
      { params: { is_active: isActive } },
    );
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, isActive ? '启用用户失败' : '禁用用户失败'));
  }
}

/* ============================ 内容审核 ============================ */

export async function fetchModeration<T>(
  kind: ModerationKind,
  params: { page: number; pageSize: number },
): Promise<T[]> {
  try {
    const { data } = await client.get<T[]>(`/admin/moderation/${kind}`, {
      params: { page: params.page, page_size: params.pageSize },
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    throw new Error(toMessage(e, '获取待审核内容失败'));
  }
}

export async function deleteModeration(
  kind: ModerationKind,
  id: number,
): Promise<ApiMessage> {
  try {
    const { data } = await client.delete<ApiMessage>(`/admin/moderation/${kind}/${id}`);
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除失败'));
  }
}

/* ============================ 规则书（原始文件） ============================ */

/** 某桌游的规则书列表（含页数与页文件名） */
export async function fetchRuleBooks(gameId: number): Promise<AdminRuleBook[]> {
  try {
    const { data } = await client.get<AdminRuleBook[]>(
      `/admin/games/${gameId}/rule-books`,
    );
    return pickArray<AdminRuleBook>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取规则书失败'));
  }
}

/** 前台翻阅用（用户端接口，无需管理员）：GET /api/games/{id}/rule-books */
export async function fetchPublicRuleBooks(gameId: number): Promise<AdminRuleBook[]> {
  try {
    const { data } = await client.get<AdminRuleBook[]>(`/games/${gameId}/rule-books`);
    return pickArray<AdminRuleBook>(data);
  } catch {
    // 前台翻阅是增强能力，失败时静默回落到静态规则书索引
    return [];
  }
}

/** 全库规则书总览 */
export async function fetchAllRuleBooks(): Promise<AdminRuleBook[]> {
  try {
    const { data } = await client.get<AdminRuleBook[]>(`/admin/rule-books`);
    return pickArray<AdminRuleBook>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取规则书列表失败'));
  }
}

export interface UploadRuleBookOptions {
  title?: string;
  language?: string;
  isOfficial?: boolean;
  source?: string;
  sourceUrl?: string;
}

/** 上传一份规则书（PDF / 图片），只登记文件，切片由 buildRuleDocs 触发 */
export async function uploadRuleBook(
  gameId: number,
  file: File,
  options: UploadRuleBookOptions = {},
): Promise<AdminRuleBook> {
  const form = new FormData();
  form.append('file', file);
  if (options.title) form.append('title', options.title);
  if (options.language) form.append('language', options.language);
  form.append('is_official', String(options.isOfficial ?? true));
  if (options.source) form.append('source', options.source);
  if (options.sourceUrl) form.append('source_url', options.sourceUrl);
  try {
    const { data } = await client.post<AdminRuleBook>(
      `/admin/games/${gameId}/rule-books`,
      form,
      { timeout: 120000 },
    );
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '上传规则书失败'));
  }
}

/** 修改规则书元信息 */
export async function updateRuleBook(
  bookId: number,
  patch: { title?: string; language?: string; is_official?: boolean; source?: string },
): Promise<AdminRuleBook> {
  try {
    const { data } = await client.patch<AdminRuleBook>(`/admin/rule-books/${bookId}`, patch);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '修改规则书失败'));
  }
}

/** 删除规则书（磁盘文件 + 级联切片一并清理） */
export async function deleteRuleBook(
  bookId: number,
): Promise<ApiMessage & { deleted_chunks?: number }> {
  try {
    const { data } = await client.delete<ApiMessage & { deleted_chunks?: number }>(
      `/admin/rule-books/${bookId}`,
    );
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除规则书失败'));
  }
}

/** 从规则书生成 / 重建规则文档切片（PDF 抽字，图片逐页 OCR） */
export async function buildRuleDocs(
  bookId: number,
  mode: 'replace' | 'append' = 'replace',
): Promise<RuleBookBuildResult> {
  const form = new FormData();
  form.append('mode', mode);
  try {
    const { data } = await client.post<RuleBookBuildResult>(
      `/admin/rule-books/${bookId}/build-docs`,
      form,
      { timeout: 600000 },
    );
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '生成规则文档失败'));
  }
}

/* ============================ 规则文档 ============================ */

export async function fetchRuleDocStatus(gameId: number): Promise<RuleDocStatus> {
  try {
    const { data } = await client.get<RuleDocStatus>(
      `/admin/games/${gameId}/rule-docs`,
    );
    return {
      game_id: Number(data?.game_id ?? gameId),
      chunk_count: pickNumber(data?.chunk_count),
      vectorized: typeof data?.vectorized === 'boolean' ? data.vectorized : null,
    };
  } catch (e) {
    throw new Error(toMessage(e, '获取规则文档状态失败'));
  }
}

/** 已上传规则文档的桌游总览：GET /api/admin/rule-docs */
export async function fetchRuleDocList(): Promise<RuleDocSummary[]> {
  try {
    const { data } = await client.get<RuleDocSummary[]>(`/admin/rule-docs`);
    if (!Array.isArray(data)) return [];
    return data.map((row) => ({
      game_id: Number(row?.game_id ?? 0),
      game_name: typeof row?.game_name === 'string' ? row.game_name : null,
      chunk_count: pickNumber(row?.chunk_count),
      vectorized: typeof row?.vectorized === 'boolean' ? row.vectorized : null,
    }));
  } catch (e) {
    throw new Error(toMessage(e, '获取规则文档列表失败'));
  }
}

/** 某桌游的规则切片内容预览：GET /api/admin/games/{id}/rule-docs/chunks */
export async function fetchRuleDocChunks(
  gameId: number,
  limit = 50,
): Promise<RuleChunkItem[]> {
  try {
    const { data } = await client.get<RuleChunkItem[]>(
      `/admin/games/${gameId}/rule-docs/chunks`,
      { params: { limit } },
    );
    if (!Array.isArray(data)) return [];
    return data.map((row) => ({
      chunk_index: Number(row?.chunk_index ?? 0),
      content: typeof row?.content === 'string' ? row.content : '',
      char_count: pickNumber(row?.char_count),
      has_embedding: typeof row?.has_embedding === 'boolean' ? row.has_embedding : null,
    }));
  } catch (e) {
    throw new Error(toMessage(e, '获取切片内容失败'));
  }
}

/** 删除某款桌游的全部规则文档切片 */
export async function deleteRuleDocs(gameId: number): Promise<ApiMessage> {
  try {
    const { data } = await client.delete<ApiMessage>(`/admin/games/${gameId}/rule-docs`);
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除失败'));
  }
}

export interface UploadRuleDocOptions {
  /** replace=清空旧切片后写入；append=接在现有切片之后累积（多页图片用它） */
  mode?: 'replace' | 'append';
  onProgress?: (percent: number) => void;
}

/**
 * 上传说明书：multipart/form-data，字段 file + mode。
 * 图片（jpg/png/webp…）由后端走视觉模型 OCR 转文字后入库，timeout 放宽到 180s。
 */
export async function uploadRuleDoc(
  gameId: number,
  file: File,
  options: UploadRuleDocOptions | ((percent: number) => void) = {},
): Promise<RuleDocUploadResult> {
  const opts: UploadRuleDocOptions =
    typeof options === 'function' ? { onProgress: options } : options;
  const form = new FormData();
  form.append('file', file);
  form.append('mode', opts.mode ?? 'replace');
  try {
    const { data } = await client.post<RuleDocUploadResult>(
      `/admin/games/${gameId}/rule-docs`,
      form,
      {
        timeout: 180000,
        onUploadProgress: (evt) => {
          if (opts.onProgress && evt.total) {
            opts.onProgress(Math.round((evt.loaded * 100) / evt.total));
          }
        },
      },
    );
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '上传规则文档失败'));
  }
}

/** 修正单条切片正文（保存后后端自动重新向量化该片） */
export async function updateRuleChunk(
  gameId: number,
  chunkIndex: number,
  content: string,
): Promise<RuleChunkItem> {
  try {
    const { data } = await client.put<RuleChunkItem>(
      `/admin/games/${gameId}/rule-docs/chunks/${chunkIndex}`,
      { content },
    );
    return {
      chunk_index: Number(data?.chunk_index ?? chunkIndex),
      content: typeof data?.content === 'string' ? data.content : content,
      char_count: pickNumber(data?.char_count),
      has_embedding: typeof data?.has_embedding === 'boolean' ? data.has_embedding : null,
    };
  } catch (e) {
    throw new Error(toMessage(e, '保存切片失败'));
  }
}

/** 删除单条切片（后续切片序号自动前移） */
export async function deleteRuleChunk(
  gameId: number,
  chunkIndex: number,
): Promise<ApiMessage & { chunk_count?: number }> {
  try {
    const { data } = await client.delete<ApiMessage & { chunk_count?: number }>(
      `/admin/games/${gameId}/rule-docs/chunks/${chunkIndex}`,
    );
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除切片失败'));
  }
}

/** 给缺向量的切片补 embedding */
export async function reembedRuleDocs(gameId: number): Promise<RuleDocStatus> {
  try {
    const { data } = await client.post<RuleDocStatus>(
      `/admin/games/${gameId}/rule-docs/reembed`,
    );
    return {
      game_id: Number(data?.game_id ?? gameId),
      chunk_count: pickNumber(data?.chunk_count),
      vectorized: typeof data?.vectorized === 'boolean' ? data.vectorized : null,
    };
  } catch (e) {
    throw new Error(toMessage(e, '补向量失败'));
  }
}

/* ============================ P3 评测中心 ============================ */

export async function fetchEvalCases(gameId?: number): Promise<EvalCase[]> {
  try {
    const { data } = await client.get<EvalCase[]>('/admin/evals/cases', {
      params: { game_id: gameId || undefined },
    });
    return pickArray<EvalCase>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取评测用例失败'));
  }
}

export async function createEvalCase(payload: EvalCasePayload): Promise<EvalCase> {
  try {
    const { data } = await client.post<EvalCase>('/admin/evals/cases', payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '新增评测用例失败'));
  }
}

export async function updateEvalCase(
  caseId: number,
  payload: Partial<EvalCasePayload>,
): Promise<EvalCase> {
  try {
    const { data } = await client.put<EvalCase>(`/admin/evals/cases/${caseId}`, payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '保存评测用例失败'));
  }
}

export async function deleteEvalCase(caseId: number): Promise<ApiMessage> {
  try {
    const { data } = await client.delete<ApiMessage>(`/admin/evals/cases/${caseId}`);
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除评测用例失败'));
  }
}

/** 创建批次：后端立即返回 run_id，实际评测在后台跑，前端轮询详情 */
export async function createEvalRun(payload: {
  case_ids?: number[];
  game_id?: number;
  note?: string;
}): Promise<EvalRun> {
  try {
    const { data } = await client.post<EvalRun>('/admin/evals/runs', payload);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '启动评测失败'));
  }
}

export async function fetchEvalRuns(limit = 20): Promise<EvalRun[]> {
  try {
    const { data } = await client.get<EvalRun[]>('/admin/evals/runs', {
      params: { limit },
    });
    return pickArray<EvalRun>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取评测批次失败'));
  }
}

export async function fetchEvalRunDetail(runId: number): Promise<EvalRunDetail> {
  try {
    const { data } = await client.get<EvalRunDetail>(`/admin/evals/runs/${runId}`);
    return {
      ...data,
      results: pickArray(data?.results),
    };
  } catch (e) {
    throw new Error(toMessage(e, '获取评测结果失败'));
  }
}

export async function deleteEvalRun(runId: number): Promise<ApiMessage> {
  try {
    const { data } = await client.delete<ApiMessage>(`/admin/evals/runs/${runId}`);
    return data ?? {};
  } catch (e) {
    throw new Error(toMessage(e, '删除评测批次失败'));
  }
}

/* ============================ P4 系统配置 ============================ */

export async function fetchRuntimeConfigs(): Promise<RuntimeConfigItem[]> {
  try {
    const { data } = await client.get<RuntimeConfigItem[]>('/admin/configs');
    return pickArray<RuntimeConfigItem>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取系统配置失败'));
  }
}

/** 修改生效值：后端写入数据库并立即应用到当前进程，无需重启 */
export async function updateRuntimeConfig(
  key: string,
  value: ConfigValue,
): Promise<RuntimeConfigItem> {
  try {
    const { data } = await client.put<RuntimeConfigItem>(`/admin/configs/${key}`, { value });
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '保存配置失败'));
  }
}

/** 删除数据库覆盖，回到 .env 默认值 */
export async function resetRuntimeConfig(key: string): Promise<RuntimeConfigItem> {
  try {
    const { data } = await client.delete<RuntimeConfigItem>(`/admin/configs/${key}`);
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '恢复默认值失败'));
  }
}

export async function fetchConfigAudits(
  key?: string,
  limit = 50,
): Promise<ConfigAuditItem[]> {
  try {
    const { data } = await client.get<ConfigAuditItem[]>('/admin/configs/audits', {
      params: { key: key || undefined, limit },
    });
    return pickArray<ConfigAuditItem>(data);
  } catch (e) {
    throw new Error(toMessage(e, '获取变更记录失败'));
  }
}

/** 回滚：把该记录的旧值写回并再记一条 rollback 审计 */
export async function rollbackConfigAudit(auditId: number): Promise<RuntimeConfigItem> {
  try {
    const { data } = await client.post<RuntimeConfigItem>(
      `/admin/configs/audits/${auditId}/rollback`,
    );
    return data;
  } catch (e) {
    throw new Error(toMessage(e, '回滚失败'));
  }
}
