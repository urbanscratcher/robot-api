import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": { target: "http://127.0.0.1:5174", changeOrigin: true },
      // 3000번을 다른 서버가 쓰고 있으면 BACKEND_URL=http://localhost:3007 처럼 바꿔서 실행
      '/api': process.env.BACKEND_URL ?? 'http://localhost:3000',
    },
  },
})
