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

## Roadmap

- [x] **Phase 0** — TS 骨架、lint、format、license、env 驱动配置
- [x] **Phase 1** — systemd unit、结构化日志、SIGTERM 级联、子进程自动重启
- [x] **Phase 2** — SQLite 持久化（会话历史 + 幂等去重，重启不丢）
- [x] **Phase 3** — 群聊 `@` 触发、多消息类型、Markdown 回复
- [x] **Phase 4** — LLM 工具循环，已审 lark-cli 工具白名单
- [ ] **Phase 5** — Docker 镜像、npm publish、v0.1.0 GitHub Release

进度跟踪：[issues](https://github.com/lizhihao-leo/lark-agent-bridge/issues)

---

## License

[MIT](LICENSE) © 2026 lizhihao-leo
