import axios from 'axios';
import { useAuthStore } from '../../stores/auth';

const client = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// 请求拦截器：自动携带 JWT
client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器：401 时登出并跳转对应端登录页
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      const isAdminPath = window.location.pathname.startsWith('/admin');
      window.location.href = isAdminPath ? '/admin/login' : '/login';
    }
    return Promise.reject(error);
  },
);

export default client;
