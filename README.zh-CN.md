# lark-agent-bridge — 中文版

> 5 分钟把任意 LLM agent 接入飞书/Lark，无需 webhook、无需公网域名、无需自己处理事件加签。

[English README](README.md)

`lark-agent-bridge` 是一座**飞书/Lark 事件**到**任何兼容 Anthropic 协议的 LLM**（官方 Claude、火山方舟 ARK、AWS Bedrock 代理……）的桥梁。它复用官方 [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli) 处理最难的部分（长连接事件订阅、Token 刷新、payload 规范化），让你拿到一个**精简、有主张、可被任何 Node/TS 项目复用**的 worker。

这就是飞书内部 `OPENCLAW_HOME` / `HERMES_HOME` 类 agent 的标准架构——本仓库把它打包成你可以 `git clone` 直接用的开源项目。

---

## 为什么用长连接而不是 webhook？

| | Webhook | 长连接（本仓库） |
|---|---|---|
| 公网 HTTPS endpoint | 需要 | **不需要** |
| TLS 证书 / 域名 | 需要 | 不需要 |
| URL 验证、签名校验 | 自己实现 | `lark-cli` 接管 |
| 掉线期间补偿投递 | 看你怎么部署 | 服务端重试窗口 |
| 本地开发 | 需要内网穿透 | 直接可跑 |

未来如果需要 webhook（比如多副本部署），`src/worker.ts` 完全保留——只换事件源。

---

## 快速上手

```bash
# 1. 安装官方 Lark CLI 并完成鉴权（每台机器 + 每个用户一次）
sudo npm install -g @larksuite/cli@latest
lark-cli config init --new       # 输入你的 App ID / App Secret
lark-cli auth login --recommend  # Device Flow，飞书 App 扫码授权
lark-cli doctor                  # 应当全部 pass

# 2. 克隆并安装
git clone https://github.com/lizhihao-leo/lark-agent-bridge.git
cd lark-agent-bridge
npm install

# 3. 配置
cp .env.example .env             # 至少填 ANTHROPIC_AUTH_TOKEN
$EDITOR .env

# 4. 开发模式启动
npm run dev
```

在飞书开放平台后台确认：

- **事件订阅** 模式选 **长连接**（不是 webhook）
- 已添加 `im.message.receive_v1`
- 已申请 scope：`im:message.p2p_msg:readonly`（读）+ `im:message:send_as_bot`（写）
- 已**发布版本**（自建应用必须）

在飞书私聊机器人或群里 @ 它，1~2 秒内应当看到回复。

---

## 配置项

完整列表见 [`.env.example`](.env.example)，关键项：

| 变量 | 默认 | 作用 |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | _(必填)_ | LLM API Key |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | LLM endpoint |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | 模型 ID |
| `LARK_EVENT_KEY` | `im.message.receive_v1` | 订阅的事件 |
| `BACKEND` | `anthropic-sdk` | `anthropic-sdk` 或 `claude-code` |
| `CLAUDE_CODE_SANDBOX` | `~/lark-bot-sandbox` | `claude-code` 后端的 cwd（也是图片引用的解析根） |
| `STORE_PATH` | `data/bridge.sqlite` | SQLite 持久化路径 |
| `GROUP_TRIGGER` | `mention` | 群消息触发策略（`mention`/`all`/`off`）|
| `BOT_AT_PREFIX` | _(空)_ | 群里要剥离的机器人 @ 前缀 |
| `ENABLE_TOOLS` | `false` | 启用 LLM tool-use 循环（调 lark-cli 工具） |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

### 用火山方舟 ARK / OpenAI 兼容代理 / Bedrock

只要 endpoint 说 Anthropic 协议就能用。ARK 示例：

```env
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
ANTHROPIC_AUTH_TOKEN=ark-xxxxxxxx
ANTHROPIC_MODEL=ark-code-latest
```

经实测：**ARK 的 /api/plan 后端 GLM-5.2 完整支持 Anthropic 工具协议**，`ENABLE_TOOLS=true` 可用。其它兼容代理建议先开 debug 日志 + 关闭 `ENABLE_TOOLS` 试探。

---

## 架构

```
[飞书云] ──长连接──> [lark-cli event daemon] ──NDJSON stdout──>
   [worker.ts]
     ├─ event_id 持久去重（SQLite）
     ├─ 按 chat_id 持久会话历史（SQLite）
     ├─ Anthropic SDK，可选工具循环
     └─ lark-cli im +messages-reply
```

详细架构与失效场景见 [`docs/architecture.md`](docs/architecture.md)，部署见 [`docs/deployment.md`](docs/deployment.md)。

---

## 两套后端

通过 `.env` 里的 `BACKEND=` 选择，自由切换、互不影响。

### `anthropic-sdk`（默认）— 便宜、快、单轮

每条飞书消息一次 HTTP `messages.create`。会话历史走 bridge 自己的
SQLite。工具调用是 `src/tools.ts` 里 5 个 lark-cli 白名单包装的 6 轮
循环，需要 `ENABLE_TOOLS=true` 才打开。

适用：纯聊天、低延迟、成本可控、任意 Anthropic 协议代理。

### `claude-code` — 真 agent、沙箱

每条飞书消息 `spawn` 一个 `claude -p --bare --dangerously-skip-permissions
--output-format stream-json --verbose` 子进程。Claude Code 得到完整 agent 能力（Bash /
Read / Write / Edit / Grep + 你装的 MCP / Skills），但 cwd 锁死在
`CLAUDE_CODE_SANDBOX`（默认 `~/lark-bot-sandbox`）。每个飞书 `chat_id`
对应一个稳定 UUID 作为 `--session-id`，存在 `<sandbox>/.bridge-sessions.json`，
重启不丢上下文。

bridge 实时解析 NDJSON 流：tool-use 事件直落日志；回复里 `![alt](path)`
形式引用沙箱内文件时，自动上传成飞书原生 image 消息（Phase 8）；回复
本身用**交互卡片**承载，并随 agent 进度实时 PATCH（Phase 9）——状态
表头、工具日志逐条增长、正文文本 token 级出现。收到消息后 ~200 ms 用
emoji（默认 `OK`）回应；完成卡片自带「🔄 重新生成」按钮（按钮回调需
飞书后台开启回调，详见 `.env.example`）。

适用：让 LLM 自主多步规划、跑命令、写文件、调外部 CLI 的场景。

| | `anthropic-sdk` | `claude-code` |
|---|---|---|
| 工具集 | 5 个 lark-cli 包装 | Claude Code 内置 + Bash + MCP |
| 每条消息成本 | 一次模型调用 | 一般 3–15 次 |
| 延迟 | 1–3 秒 | 3–15 秒 |
| 工作目录 | 无 | 沙箱化 |
| 会话内存 | bridge SQLite | Claude Code session 文件 |
| 模型供应商 | 任意 Anthropic 兼容 | 同左，Claude Code 也走 `ANTHROPIC_*` env |

```env
# 火山方舟 ARK + Claude Code 后端
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
ANTHROPIC_AUTH_TOKEN=ark-xxxxxxxx
BACKEND=claude-code
CLAUDE_CODE_SANDBOX=/home/leo/lark-bot-sandbox
```

---

## Roadmap

- [x] **Phase 0** — TS 骨架、lint、format、license、env 驱动配置
- [x] **Phase 1** — systemd unit、结构化日志、SIGTERM 级联、子进程自动重启
- [x] **Phase 2** — SQLite 持久化（会话历史 + 幂等去重，重启不丢）
- [x] **Phase 3** — 群聊 `@` 触发、多消息类型、Markdown 回复
- [x] **Phase 4** — LLM 工具循环，已审 lark-cli 工具白名单
- [x] **Phase 5** — CI、CONTRIBUTING、SECURITY、中英双语
- [x] **Phase 6** — Claude Code headless 后端（沙箱 agent loop）
- [x] **Phase 7** — 流式输出（实时工具日志）+ "⏳ 思考中…" 占位 + user-mode systemd
- [x] **Phase 8** — `BACKEND=claude-code` 的图片回复（沙箱内 PNG 自动上传成飞书 image 消息）
- [x] **Phase 9** — 交互卡片真流式 PATCH + emoji 立即 ack + 「🔄 重新生成」按钮回调（需 `ENABLE_CARD_CALLBACK=true` 且飞书后台开启回调）
- [x] **Phase 10** — 生产加固：每用户限速 + 用户/会话白名单、vision 输入（图片消息落沙箱 `in/`）、「⏹ 停止」按钮中止运行中的对话、Prometheus `/metrics` endpoint
- [ ] **Phase 11** — Docker 镜像、npm publish、v0.1.0 Release

进度跟踪：[issues](https://github.com/lizhihao-leo/lark-agent-bridge/issues)

---

## License

[MIT](LICENSE) © 2026 lizhihao-leo
