import { create } from 'zustand';
import type { User } from '../shared/types';

const TOKEN_KEY = 'tablemind_token';
const USER_KEY = 'tablemind_user';

interface AuthState {
  token: string | null;
  user: User | null;
  login: (token: string, user: User) => void;
  /** 资料/头像更新后同步登录态，避免刷新才生效 */
  setUser: (user: User) => void;
  logout: () => void;
}

const savedUser = localStorage.getItem(USER_KEY);

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem(TOKEN_KEY),
  user: savedUser ? (JSON.parse(savedUser) as User) : null,
  login: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ token, user });
  },
  setUser: (user) => {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user });
  },
  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null });
  },
}));
