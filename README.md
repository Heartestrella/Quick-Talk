# Quick Talk · 快聊

一个语音优先、支持屏幕共享 + 文字聊天的极简房间网页。无需注册，输入房间号或创建房间即可开始。所有媒体（语音、屏幕、文字）**通过服务器中转**，没有 P2P 打洞。

## 特性一览

- **语音** · PCM Int16 @ 16 kHz 单声道，20 ms/帧，Socket.IO 二进制中转
- **降噪** · 可选接入 [RNNoise](https://github.com/xiph/rnnoise)（WebAssembly）；加载失败自动回落到 highpass + compressor + noise gate 链
- **屏幕共享** · WebCodecs 硬编码。候选顺序 H.264 → HEVC → VP9 → AV1 → VP8。
  H.264 试完 Baseline / Main / High 各 level，观看端不吃 High 会自动切 Baseline；
  Sharer / viewer 之间通过 `need-codec` / `codec-string-unsupported` 精确协商，
  最终按每个观看端都能解码的最高质量收敛
- **可选共享音频** · 屏幕共享时勾选"共享音频"→ Opus 编码经服务器转发
- **文字聊天 + 图片** · 支持粘贴 / 附加图片，自动缩放到 1600 px 长边、JPEG 82 质量压缩
- **音量混合器** · 语音 / 屏幕音频独立主音量，每个成员可单独调音或静音
- **传输通道** · 默认 socket.io / TCP（稳）。**手动切 UDP / WebTransport** 换低延迟，
  切换时房间内所有人显示"UDP · 画面可能撕裂"警告横幅
- **房间密码** · 创建时可选设定；服务器 PBKDF2 存 `rooms.json`，浏览器本地缓存密码可自动重进
- **改名** · 房间内点右下 `YOU` 就地改名，广播给全房间
- **重连** · Socket 断开后自动重连并弹提示，恢复后自动关掉
- **HTTPS 感知** · 非 HTTPS 环境下显式提示（浏览器会禁掉麦克风 / WebCodecs / getDisplayMedia）

## 本地开发

```bash
npm install
npm run dev
```

- 前端 → https://localhost:5173 （Vite 自签证书，浏览器会警告"不安全"，选继续）
- 信令服务器 → http://localhost:3001 （Vite 代理转发 `/socket.io`）

## 使用

1. 首页输入 6 位房间号加入，或点击"开一个房间"（可选设置房间密码）
2. 进入房间后：
   - 底部麦克风按钮开麦
   - 底部屏幕按钮打开菜单，选分辨率 / 帧率 / 码率 / codec，再点"开始共享"
   - 右侧聊天面板可发文字或粘贴 / 附加图片
   - 右上角"音量"按钮打开混音器；"TCP" chip 点一下切 UDP
   - 右下角自己的名字可点击就地改名
3. 分享房间号或点顶栏"分享链接"给对方

## 快捷键

- `M` 切换麦克风
- `S` 切换屏幕共享
- `D` 切换降噪

## 技术栈

- Vue 3 + Vite（前端）
- Socket.IO（TCP 信令 + 媒体中转）
- [@fails-components/webtransport](https://github.com/fails-components/webtransport)（可选 UDP / QUIC 路径）
- [@shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm)（RNNoise 语音降噪，懒加载）
- Express（静态资源 + health）
- 浏览器原生 API：WebCodecs（VideoEncoder / VideoDecoder / AudioEncoder / AudioDecoder）
  + AudioWorklet + MediaStreamTrackProcessor + WebTransport

## 项目结构

```
├── index.html
├── package.json
├── vite.config.js
├── config.example.json       # 复制成 config.json 生效
├── public/
│   ├── pcm-worklet.js        # 16k Int16 / 48k Float32 双模 PCM 采集 worklet
│   ├── favicon*.png / .ico
│   └── apple-touch-icon.png
├── scripts/
│   └── udp-check.py          # 探测远端 UDP / QUIC 是否可达
├── server/
│   ├── index.js              # Socket.IO 中转 + 静态资源 + 房间密码 + WT 集成入口
│   └── webtransport.js       # HTTP/3 relay：uni-stream 转屏幕 chunk + datagram 心跳
└── src/
    ├── main.js / router.js / App.vue / styles.css
    ├── views/
    │   ├── Landing.vue       # 首页 + 创建密码 + 昵称持久化
    │   └── Room.vue          # 房间主界面 + 密码弹层 + 改名 + UDP 横幅
    ├── components/
    │   ├── Waveform.vue      # 语音波形
    │   ├── Participant.vue   # 头像卡
    │   ├── ScreenView.vue    # 屏幕共享回放
    │   └── AudioMixer.vue    # 主 + 每人音量 / 静音
    └── composables/
        ├── useRoom.js        # 房间状态机 + 采集/编码/解码/中转
        └── useTransport.js   # WebTransport 客户端封装 + 心跳
```

## 部署

生产环境：**同一个 Node 进程同时提供前端静态资源 + Socket.IO 中转 + 可选 WebTransport**。
一份 `config.json`，一到两个端口，搞定。

### ⚠ 关于 HTTPS（**非常重要**）

麦克风、屏幕共享、WebCodecs、WebTransport 全部要求 **Secure Context** —— 也就是 HTTPS
（`localhost` 是唯一豁免）。**只要你通过 `http://<IP>` 或 `http://<域名>`
访问，浏览器会静默地把 `VideoEncoder` / `MediaStreamTrackProcessor` /
`navigator.mediaDevices` 设成 undefined**，前端会看到"当前站点不是 HTTPS"
的红条以及"屏幕共享 API 被禁用"的提示。

三种搭 HTTPS 的方式，任选一种：

- **A. 反向代理接管 TLS（生产推荐）** —— 见下面的 Nginx / Caddy 配置
- **B. Node 直接开 HTTPS** —— 在 `config.json` 里填 `ssl.cert` / `ssl.key` 路径
- **C. 内网 / 临时自签**

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=$(hostname -I | awk '{print $1}')"
# 然后在 config.json 里填 ./cert.pem 和 ./key.pem
```
手机首次访问会警告"不安全"，选"继续访问"就能用。

### 前置

- Node.js **≥ 20**（RNNoise wasm 模块要求）
- 端口：默认 `3001` TCP（HTTP/S + WebSocket），可选 `4433` UDP（WebTransport / QUIC）

### 方案 A：服务器上直接构建（推荐）

```bash
git clone <repo> quick-talk && cd quick-talk
npm ci                          # 装齐 dev + prod 依赖
cp config.example.json config.json
$EDITOR config.json             # 填 host / port / ssl / webtransport
npm run build                   # 产出 dist/
npm start                       # 单进程 SPA + Socket.IO + (可选) WT
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
rsync -av server/ package.json package-lock.json config.example.json server:/opt/quick-talk/
```

服务器上：

```bash
cd /opt/quick-talk
cp config.example.json config.json && $EDITOR config.json
npm ci --omit=dev
npm start
```

### 用 PM2 常驻

```bash
npm i -g pm2
pm2 start server/index.js --name quick-talk
pm2 save && pm2 startup
```

### 配置文件 `config.json`

复制 `config.example.json` 修改。字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `0.0.0.0` | 绑定网卡 |
| `port` | `3001` | Node HTTP/S 端口（socket.io 走这个） |
| `ssl.cert` / `ssl.key` | *(空)* | PEM 路径。**都填才启用 HTTPS**；WebTransport 也要 HTTPS 才能工作 |
| `webtransport.port` | `0`（关） | UDP/QUIC 监听端口。设 `4433` 一类的值就开启，需要与 SSL 一同启用 |
| `webtransport.host` | 同 `host` | WT 绑定网卡 |
| `webtransport.publicUrl` | 自动 | 客户端连的 URL，反代 / 有独立 UDP 入口时手动指定，例如 `https://qt.example.com:4433` |

不放 `config.json` 也能跑（HTTP + 无 WT），仅限本机 / 局域网测试。

### WebTransport（UDP / QUIC）额外注意

- 只有 **HTTPS** 环境下才生效（否则浏览器不给用 `WebTransport`）
- 4433/UDP 必须公网可达 —— 常见坑：
  - **Cloudflare Tunnel / 免费 proxy 不转发 UDP**（关掉 orange cloud，让流量直连 IP）
  - 服务器防火墙 / 云安全组默认不放 UDP，需要手动加规则
  - Docker 需要 `-p 4433:4433/udp`（带 `/udp` 后缀）
- 前端默认走 TCP，用户手动点右上角 chip 才切 UDP。切了后无论是否共享屏幕都持续显示警告横幅提醒。
- 用 `scripts/udp-check.py <host> <port>` 从本机探测远端是否真的可以通 UDP + QUIC：
  ```bash
  python scripts/udp-check.py qt.example.com 4433
  ```
  三步：DNS 解析、8 字节 UDP 打点、真实 1200B QUIC Initial 包。任何一步失败会给出可能原因。

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

  # 屏幕共享关键帧可能 200 KB+
  client_max_body_size 32M;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;

  location / {
    proxy_pass http://127.0.0.1:3001;
  }
}
```

Nginx 只处理 TCP。**WebTransport 端口 4433 需要单独放行 UDP，不要走 Nginx**。

### Caddy（更简单）

```
talk.example.com {
  reverse_proxy 127.0.0.1:3001
}
```

### 健康检查

`GET /health` → `{ ok: true, ts: <毫秒> }`，可以直接接进 Nginx / 云负载均衡的 health probe。

### 房间密码数据

服务器把每个设过密码的房间以 PBKDF2-SHA256 哈希存到 `rooms.json`（每次房间创建者第一次带密码 join 就写入）。想清空重来 —— 停服务，删掉 `rooms.json`，起服务。

## 说明

- **语音**：全部通过 Socket.IO 二进制中转
- **屏幕**：默认 Socket.IO；用户切换后走 WebTransport（QUIC uni-stream）
- **不使用 WebRTC / STUN / TURN**，没有 P2P 打洞问题；反面是所有上下行都经过服务器
- **房间容量**：语音质量约 8 人内舒适，屏幕共享推荐 4 人内。上行 = 你的语音 + 屏幕码率；下行 = 其他每个人的语音 + 一个人的屏幕
