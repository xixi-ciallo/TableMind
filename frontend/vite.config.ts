import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // 帖子图片 / 视频等上传资源的静态目录
      '/uploads': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 把体积大的依赖与数据层拆成独立 chunk，配合路由懒加载减少首屏体积
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            // 真实数据层单独成块：内容大但很少变动，可长期缓存
            if (id.includes('shared/gameLibrary')) return 'data-catalog';
            return undefined;
          }
          if (id.includes('react-router') || id.includes('/react/') || id.includes('/react-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('antd') || id.includes('@ant-design') || id.includes('rc-')) {
            return 'vendor-antd';
          }
          if (id.includes('axios') || id.includes('zustand')) {
            return 'vendor-utils';
          }
          return 'vendor';
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
