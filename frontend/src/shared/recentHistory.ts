/**
 * 本机浏览历史（localStorage）：个人中心、侧边栏、详情页共用。
 *
 * 存储格式为 { id, ts } 数组（ts 为最近一次浏览的毫秒时间戳，0 表示旧数据无时间）。
 * 兼容历史格式（纯 id 数组），读取时自动归一化。
 */

export interface RecentEntry {
  id: number;
  /** 最近一次浏览的毫秒时间戳；旧数据无时间时为 0 */
  ts: number;
}

export const RECENT_KEY = 'tablemind_recent';
export const RECENT_MAX = 24;

/** 读取浏览历史（新 → 旧），自动兼容旧的纯 id 数组格式 */
export function readRecentEntries(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as (number | RecentEntry)[])
      .map((x) => (typeof x === 'number' ? { id: x, ts: 0 } : x))
      .filter((e) => e && typeof e.id === 'number');
  } catch {
    return [];
  }
}

/** 兼容旧调用：只取 id 列表（新 → 旧） */
export function readRecentIds(): number[] {
  return readRecentEntries().map((e) => e.id);
}

/** 写入完整列表（调用方保证新 → 旧顺序） */
export function writeRecentEntries(entries: RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, RECENT_MAX)));
  } catch {
    /* 隐私模式下写入失败可忽略 */
  }
}

/** 记录一次浏览：置顶去重 */
export function pushRecentEntry(id: number, ts: number = Date.now()): void {
  const next = [{ id, ts }, ...readRecentEntries().filter((e) => e.id !== id)];
  writeRecentEntries(next);
}

/** 删除单条 */
export function removeRecentEntry(id: number): void {
  writeRecentEntries(readRecentEntries().filter((e) => e.id !== id));
}

/** 清空全部 */
export function clearRecentEntries(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* 忽略 */
  }
}
