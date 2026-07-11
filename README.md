# Quick Talk · 快聊

一个语音优先、支持屏幕共享的极简聊天网页。无需登录，输入房间号或创建房间即可开始。

## 启动

```bash
npm install
npm run dev
```

前端 → http://localhost:5173
信令服务器 → http://localhost:3001（由 Vite 代理转发 `/socket.io`）

## 使用

1. 打开首页，输入 6 位房间号加入，或点击"开一个房间"
2. 进入房间后：
   - 点击左下"开启麦克风"（浏览器会请求权限）
   - 点击"共享屏幕"选择要分享的窗口/屏幕
   - 点击"文字消息"打开侧边聊天面板
3. 把地址栏里的房间号分享给朋友，他们打开链接就能加入

## 快捷键

- `M` 切换麦克风
- `S` 切换屏幕共享
- `C` 打开/关闭聊天

## 技术栈

- Vue 3 + Vite（前端）
- WebRTC（音频 + 屏幕共享 P2P）
- Socket.io（信令中转）
- Express（信令服务器）

## 项目结构

```
├── index.html
├── package.json
├── vite.config.js
├── server/
│   └── index.js           # Socket.io 信令服务器
└── src/
    ├── main.js
    ├── router.js
    ├── App.vue
    ├── styles.css         # 设计令牌
    ├── views/
    │   ├── Landing.vue    # 首页
    │   └── Room.vue       # 房间页
    ├── components/
    │   ├── Waveform.vue   # 波形可视化
    │   ├── Participant.vue# 参与者卡片
    │   └── ScreenView.vue # 屏幕共享视图
    └── composables/
        └── useRoom.js     # 房间状态 + WebRTC
```

## 部署

生产环境：**同一个 Node 进程同时提供前端静态资源 + Socket.IO 中转**，
只需要暴露一个端口。

### 前置

- Node.js **≥ 18**
- 端口：默认 `3001`（可通过 `PORT` 环境变量覆盖）
- HTTPS 必须（Chrome / Safari 移动端要求 `getUserMedia` / `getDisplayMedia` 走
  HTTPS）。生产建议在 **前面挂一个反向代理终止 TLS**（Nginx / Caddy / Cloudflare 均可）。

### 方案 A：服务器上直接构建（推荐）

```bash
git clone <repo> quick-talk && cd quick-talk
npm ci                    # 装齐 dev + prod 依赖
npm run build             # 产出 dist/
PORT=3001 npm start       # 单进程同时服务 SPA + Socket.IO
```

如果服务器要长期常驻，构建完可以清掉 dev 依赖节省空间：

```bash
npm prune --omit=dev
```

### 方案 B：本地构建，把 dist 上传

服务器上 CPU / 内存紧张时用这种。本地：

```bash
npm ci && npm run build
rsync -av dist/ server:/opt/quick-talk/dist/
rsync -av server/ package.json package-lock.json server:/opt/quick-talk/
```

服务器上：

```bash
cd /opt/quick-talk
npm ci --omit=dev         # 只装运行时依赖
PORT=3001 npm start
```

### 用 PM2 常驻

```bash
npm i -g pm2
PORT=3001 pm2 start server/index.js --name quick-talk
pm2 save && pm2 startup
```

### Nginx 反向代理示例

```nginx
server {
  listen 443 ssl http2;
  server_name talk.example.com;
  ssl_certificate     /etc/letsencrypt/live/talk.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/talk.example.com/privkey.pem;

  # WebSocket 升级必须
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;

  # 屏幕共享关键帧可能 200 KB+，把默认 buffer 放宽
  client_max_body_size 32M;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;

  location / {
    proxy_pass http://127.0.0.1:3001;
  }
}
```

### Caddy（更简单）

```
talk.example.com {
  reverse_proxy 127.0.0.1:3001
}
```

### 环境变量

| 变量       | 默认       | 说明                    |
| ---------- | ---------- | ----------------------- |
| `PORT`     | `3001`     | Node 服务监听端口       |
| `HOST`     | `0.0.0.0`  | 绑定网卡                |

### 健康检查

`GET /health` 返回 `{ ok: true, ts: <毫秒> }`，可以直接接进 Nginx / 云负载均衡的
health probe。

## 说明

- 音频：**PCM Int16 @ 16 kHz 单声道**，20 ms 一帧，全部通过 Socket.IO 二进制中转
- 屏幕：**WebCodecs 硬编码**（默认 VP9，遇到不支持的解码端会自动切 H.264），
  同样走 Socket.IO 转发。**不使用 WebRTC / STUN / TURN**，没有 P2P 打洞问题。
- 房间容量按语音质量看约 8 人内舒适，屏幕共享推荐 4 人内。上行带宽等于
  你自己的语音码率 + 屏幕码率；下行等于其他每个人的语音 + 一个人的屏幕。
