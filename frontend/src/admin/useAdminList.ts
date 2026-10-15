/**
 * 管理端列表通用状态机：加载 / 错误（可重试）/ 空态 / 分页 / 防抖搜索。
 *
 * 后端所有列表接口都返回「裸数组」且不带 total，因此这里采用
 * 「多取一条探测下一页」的方式：请求 pageSize + 1，若实际返回多于 pageSize 说明还有下一页。
 * 这样既不谎报总数，也能给出可用的翻页控件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TablePaginationConfig } from 'antd';

export interface AdminListParams {
  page: number;
  pageSize: number;
  search?: string;
}

export interface AdminList<T> {
  rows: T[];
  loading: boolean;
  error: string | null;
  page: number;
  pageSize: number;
  /** 输入框当前值（含未提交的草稿） */
  search: string;
  hasNext: boolean;
  setSearch: (v: string) => void;
  setPage: (page: number) => void;
  reload: () => void;
}

export interface UseAdminListOptions {
  pageSize?: number;
  /** 搜索防抖毫秒数 */
  debounce?: number;
}

export function useAdminList<T>(
  fetcher: (params: AdminListParams) => Promise<T[]>,
  options: UseAdminListOptions = {},
): AdminList<T> {
  const { pageSize = 10, debounce = 400 } = options;

  // fetcher 通常是页面内的箭头函数，每次渲染都是新引用，放进 ref 避免重复触发请求
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // 搜索输入防抖：停止输入 400ms 后回到第 1 页重新拉取
  useEffect(() => {
    if (draft === applied) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setApplied(draft);
    }, debounce);
    return () => window.clearTimeout(timer);
  }, [draft, applied, debounce]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    fetcherRef
      .current({ page, pageSize: pageSize + 1, search: applied.trim() || undefined })
      .then((data) => {
        if (!alive) return;
        const list = Array.isArray(data) ? data : [];
        setHasNext(list.length > pageSize);
        setRows(list.slice(0, pageSize));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setRows([]);
        setHasNext(false);
        setError(e instanceof Error ? e.message : '加载失败，请稍后重试');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [page, pageSize, applied, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    rows,
    loading,
    error,
    page,
    pageSize,
    search: draft,
    hasNext,
    setSearch: setDraft,
    setPage,
    reload,
  };
}

/**
 * 生成 antd Table 的分页配置。
 * 总数未知时用「当前页 * 每页 + 1」告诉控件还有下一页，不谎报真实总数。
 */
export function listPagination<T>(list: AdminList<T>): TablePaginationConfig {
  const known = (list.page - 1) * list.pageSize + list.rows.length;
  return {
    current: list.page,
    pageSize: list.pageSize,
    total: list.hasNext ? list.page * list.pageSize + 1 : known,
    showSizeChanger: false,
    hideOnSinglePage: true,
    onChange: list.setPage,
  };
}

export interface AdminPagedResult<T> {
  items: T[];
  total: number;
  /** 接口附带的其它聚合值（如待补全数量），原样透出给页面 */
  extra?: Record<string, number>;
}

export interface AdminPagedList<T> extends Omit<AdminList<T>, 'hasNext'> {
  total: number;
  extra: Record<string, number>;
}

/**
 * 带真实总数的列表（后端返回 { total, items } 时用它）。
 *
 * 与 useAdminList 的区别：不再用「多取一条探测下一页」，
 * 直接以后端 count(*) 结果驱动分页，页码与总条数都准确。
 */
export function useAdminPagedList<T>(
  fetcher: (params: AdminListParams) => Promise<AdminPagedResult<T>>,
  options: UseAdminListOptions = {},
): AdminPagedList<T> {
  const { pageSize = 10, debounce = 400 } = options;

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [extra, setExtra] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (draft === applied) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setApplied(draft);
    }, debounce);
    return () => window.clearTimeout(timer);
  }, [draft, applied, debounce]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    fetcherRef
      .current({ page, pageSize, search: applied.trim() || undefined })
      .then((res) => {
        if (!alive) return;
        setRows(Array.isArray(res?.items) ? res.items : []);
        setTotal(typeof res?.total === 'number' ? res.total : 0);
        setExtra(res?.extra ?? {});
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setRows([]);
        setTotal(0);
        setExtra({});
        setError(e instanceof Error ? e.message : '加载失败，请稍后重试');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [page, pageSize, applied, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    rows,
    loading,
    error,
    page,
    pageSize,
    search: draft,
    total,
    extra,
    setSearch: setDraft,
    setPage,
    reload,
  };
}

/** 已知总数时的分页配置：显示「共 N 条」并支持跳页 */
export function pagedPagination<T>(list: AdminPagedList<T>): TablePaginationConfig {
  return {
    current: list.page,
    pageSize: list.pageSize,
    total: list.total,
    showSizeChanger: false,
    showTotal: (n) => `共 ${n} 条`,
    hideOnSinglePage: true,
    onChange: list.setPage,
  };
}
