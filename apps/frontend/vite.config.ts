import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 배포 환경의 nginx.conf와 같이 관찰 API는 h.joun.cc로 넘긴다.
      '^/api/(observations|transcripts)$': {
        target: 'https://h.joun.cc',
        changeOrigin: true,
        headers: { origin: '' },
      },
      '/api/mobile/publications': {
        target: 'https://h.joun.cc',
        changeOrigin: true,
        headers: { origin: '' },
      },
      // 3000번을 다른 서버가 쓰고 있으면 BACKEND_URL=http://localhost:3007 처럼 바꿔서 실행
      '/api': process.env.BACKEND_URL ?? 'http://localhost:3000',
    },
  },
})
