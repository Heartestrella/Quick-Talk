import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

// HTTPS 打开：移动端浏览器需要 HTTPS 才能访问麦克风 / 屏幕共享。
// 自签名证书，第一次访问手机会提示"不安全"，选"仍要访问"即可。
export default defineConfig({
  plugins: [vue(), basicSsl()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    https: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
        secure: false
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    https: true
  }
})
