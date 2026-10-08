# xhsflow

小红书品牌 / 营销 / IP 图文内容的**自动生产线**。本地常驻服务，浏览器打开就能用：

```
作者主页链接 → 抓全量图文 + 图片 → 蒸馏成语料库 → 定时批量产稿 → 你审核 → 发到你的小红书
```

不开官方开放平台，全部走网页侧请求 + 浏览器自动化。**不生图** —— 配图要么从免费图库取，要么用代码按语料库的排版风格渲染。

---

## 快速开始

```bash
npm install          # 会自动下载 Chromium
cp .env.example .env # 填模型 key（至少填这个）
npm start            # 构建 + 启动 + 自动打开浏览器
```

打开 `http://127.0.0.1:8787`，按左边的导航走：

| 页面 | 做什么 |
|---|---|
| **总览** | 看登录状态、队列、事件日志；扫码登录 |
| **语料库** | 粘贴作者主页链接 → 抓取全部图文作品 |
| **草稿审核** | 逐篇看卡片大图 → 通过 / 拒绝 / 改文案 |
| **发布** | 已通过的草稿排队，走创作中心网页发布 |
| **设置** | 品牌署名、定时策略、任务队列、探活 |

开发模式（前端热更新）：`npm run dev`

### 常用命令

```bash
npm start     # 构建并启动（跳过重复构建用 npm run serve）
npm run stop  # 停止后台运行的服务，并清理它拉起的浏览器
npm run typecheck
```

> **端口被占用 / 日志乱码？**
> - `EADDRINUSE 8787` 说明上次没退干净，跑一次 `npm run stop` 即可。
>   它只匹配本项目的进程，不会误杀你机器上别的 node 服务。
> - 中文日志乱码（`鍚€鍔婁槸`）是 Windows 控制台默认用 GBK 代码页渲染 UTF-8 导致的。
>   `npm start` 会自动切到 UTF-8；如果你在 **Windows PowerShell 5.1** 里仍看到乱码，
>   先执行一次 `chcp 65001`，或改用 PowerShell 7。

---

## 配置

只有两个是必填的，其余有合理默认值。见 `.env.example`。

### 文本模型

**baseURL 和 apiKey 必须成对**，因为智谱的团队套餐 key 和按量付费 key 不通用，指向的地址也不同：

| profile | baseURL | 适用 |
|---|---|---|
| `glm-coding` | `https://open.bigmodel.cn/api/coding/paas/v4` | 团队套餐 key |
| `glm-paygpt` | `https://open.bigmodel.cn/api/paas/v4` | 按量付费 key |
| `openai` | `https://api.openai.com/v1` | OpenAI |

### 图库（可选）

`UNSPLASH_ACCESS_KEY` 或 `PEXELS_API_KEY`。**都不填也能用** —— `photo_text` 版式会自动退回纯文字排版卡。

---

## 几个关键设计决策

这部分值得单独说，因为它们都不是默认选型。

### 1. 签名：不复刻算法，直接用页面自己的

小红书请求需要 `x-s` / `x-t` 签名头。生态里的做法是逆向实现（`xhshow`、`redbook` 等），但这套算法会定期轮换，谁都在追。

我们的浏览器本来就停在 `xiaohongshu.com` 上，**页面自己就带着最新版签名器**。所以 `server/src/xhs/signing.ts` 在运行时探测 `window._webmsxyw` 并调用它：

- 零逆向成本、零第三方代码
- 小红书一改算法，页面自动跟着改，**我们一行代码都不用动**
- 探针会尝试多种调用形态，并把每次尝试的结果记进事件日志，改版时能立刻看出是"没有这个全局"还是"有但形态变了"

### 2. 传输层：让浏览器替我们发请求

小红书靠 TLS ClientHello 指纹识别非浏览器客户端。成熟方案用 `curl_cffi` 伪装，**Node 没有等价能力**。

我们改用 Playwright 的 `context.request`：它走浏览器自己的网络栈（TLS 指纹是真 Chrome）、共享 cookie、且**不受 CORS 约束**。
> 最后一条很关键 —— 自定义头 `x-s`/`x-t` 会触发预检，页面内 `fetch` 直接 `Failed to fetch`，踩过这个坑。

### 3. 抓取：多级降级，不是单点

`user_posted` 是全行业公认脆弱的端点。我们按顺序降级，任一级可用即止，并把降级事件记进日志：

1. `/api/sns/web/v1/user_posted`（签名 API）
2. `/api/sns/web/v1/user/posted`（另一套命名）
3. SSR 页面 `__INITIAL_STATE__` 解析
4. 真实滚动主页，从 DOM 读

单篇详情同理：`/feed` → `/note/<id>` → SSR。

### 4. 视觉信息不让模型看图

配色、明暗、宽高比这些用 `sharp` 离线算出来，作为**事实**喂进 prompt。这样更快、零 vision token，而且「主色是 `#F5E6D3`」这种客观信息本来就该从像素里取，不该让模型猜。

### 5. 语料检索用 FTS5 trigram，不用 embedding

检索目标是"找同风格 / 同题材的样稿"，这是**关键词匹配问题**，不是稠密语义问题。几百条量级下 trigram + 标签重合度打分，比拉 300MB 的 ONNX 运行时又快又准。

> 注意必须用 `trigram` 分词器：FTS5 默认的 `unicode61` 不切分 CJK，会把一整段中文当成一个 token，中文检索直接失效。

### 6. 卡片渲染用 Chromium，不用 satori

satori 不支持 `.ttc` 字体集合，而 Windows 默认的中文字体（微软雅黑 `msyh.ttc`）**正好是 `.ttc`** —— 走那条路必踩字体坑。用 Chromium 则系统字体栈免费拿、中文断行原生正确、grid / 阴影 / 渐变全都正常。

尺寸固定 **1080×1440**（小红书原生 3:4），七种版式：`cover` / `quote` / `list` / `steps` / `compare` / `photo_text` / `cta`。

### 7. 风格画像是"可执行规格"不是"设计形容词"

作者级聚合产出的 `card_template_spec` 里是具体的 `#hex` 色值、`px` 字号、圆角、强调样式枚举 —— 渲染器直接消费。
写成"清新文艺风"那种东西没法执行。配色被模型写错时 `sanitizeSpec` 会兜底纠正，不至于让渲染器崩。

### 8. 调度：DB 表 + ticker，不要 Redis

BullMQ 那套是为 Redis 持久队列设计的，单机常驻进程用不上，代价却是一个额外服务。`jobs` 表 + 15 秒 ticker 就够了，状态在 SQLite 里，重启不丢，还顺带获得完整历史可查。

---

## 防风控

小红书风控是真的会封号，这套措施：

- **对数正态节流**：请求间隔围绕 6 秒浮动（均值固定、方差可调）。纯均匀分布反而容易被规律性检测出来
- **单并发**执行，不并发抓取
- **发布间隔**单独控制（默认 45 秒）
- **会话健康检查**：每 17 分钟探一次，`web_session` 服务端悄悄过期时能提前发现，而不是等发布失败才发现
- 建议**用小号抓取**，别用主号

### IP 被风控了怎么办

小红书会对 IP 出手，返回「安全限制 / IP存在风险」（错误码 300012）并以非 2xx 状态码响应。此时：

- **网页不渲染，扫码登录用不了**
- **但 API 仍然可用** —— 实测被限的 IP 照样能拿到正常业务信封

所以备用方案是**手动导入 Cookie**：在你自己常用的浏览器里登录小红书 → F12 Console 执行 `copy(document.cookie)` → 粘贴到操作台。整条流水线照常工作，完全绕开网页渲染环节。

---

## 目录

```
server/src/
├─ xhs/
│  ├─ signing.ts      页面原生签名器探测（不实现算法）
│  ├─ browser.ts      持久化上下文、传输层、扫码/Cookie 登录、僵尸锁自愈
│  ├─ api.ts          端点封装 + 多级降级
│  ├─ scrape.ts       主页 → 全量笔记 → 详情 → 图片
│  └─ publish.ts      创作中心 UI 自动化（选择器集中在这里）
├─ corpus/            单篇蒸馏 → 作者画像 → FTS5 检索
├─ generate/          7 种版式渲染 + LLM 生成管线
├─ media/             图片下载归一化 + 免费图库
├─ scheduler/         jobs 表 + ticker + 任务处理器
└─ diagnostics/       诊断脚本（见下）
```

### 诊断脚本

排查问题时很有用，都是真实跑过的：

```bash
node server/dist/diagnostics/verify-signing.js   # 端到端验证签名链路
node server/dist/diagnostics/inspect-signer.js   # dump 签名器真实返回值
node server/dist/diagnostics/inspect-login.js    # dump 登录入口候选选择器
node server/dist/diagnostics/render-sample.js    # 渲染 7 种版式样张
```

---

## 已知限制

- **发布走创作中心网页 UI 自动化**。选择器集中在一个文件里，但小红书改版时仍需修（只改一处）。
- **创作中心登录态与小红书网页端共用同一个浏览器 profile**，共用是特性（不用登两次），但也意味着同一个账号在两处的风控是叠加的。
- **只处理图文笔记**，视频笔记会被跳过。
- 原图分辨率受限于 CDN 下发的是压缩版本，不是用户上传的原始文件。

---

## 技术栈

Node 24 内置 `node:sqlite`（FTS5 已实测可用，零编译）· Fastify · Playwright · sharp · openai SDK · Vite + React + Tailwind

无 Python、无 Redis、无 Docker、无原生编译。