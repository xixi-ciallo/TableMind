import client from './client';
import type { User } from '../types';

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

/** 把后端错误（含 FastAPI 校验错误数组）转成可直接展示的中文文案 */
function extractError(e: unknown, fallback: string): string {
  const err = e as {
    response?: { data?: { detail?: unknown } };
    message?: string;
    code?: string;
  };
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string };
    if (first?.msg) return String(first.msg).replace(/^Value error,\s*/, '');
  }
  if (err?.code === 'ECONNABORTED') return '请求超时，请检查网络后重试';
  if (!err?.response) return '无法连接服务器，请确认后端服务已启动';
  return fallback;
}

export interface RegisterPayload {
  username: string;
  phone: string;
  password: string;
}

export async function register(payload: RegisterPayload): Promise<AuthResponse> {
  try {
    const { data } = await client.post<AuthResponse>('/auth/register', payload);
    return data;
  } catch (e) {
    throw new Error(extractError(e, '注册失败，请稍后重试'));
  }
}

export async function login(payload: {
  username: string;
  password: string;
}): Promise<AuthResponse> {
  try {
    const { data } = await client.post<AuthResponse>('/auth/login', payload);
    return data;
  } catch (e) {
    throw new Error(extractError(e, '登录失败，请稍后重试'));
  }
}

/** 用已保存的令牌换取当前用户，用于刷新页面后校验登录态是否仍有效 */
export async function fetchMe(): Promise<User> {
  const { data } = await client.get<User>('/auth/me');
  return data;
}

export const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export function isValidPhone(v: string): boolean {
  return PHONE_PATTERN.test(v.replace(/\s|-/g, ''));
}
