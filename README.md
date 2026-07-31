# Dify OpenAI Chat Completions Proxy

一个部署在 Cloudflare Workers 上的轻量 OpenAI Chat Completions 反向代理，适合把现有 Dify OpenAI-compatible Endpoint 临时共享给少量熟人。

项目没有注册、管理后台或动态 Key 管理。客户端只接触共享的 `GROUP_API_KEY`；Dify 地址和 Key 始终保存在 Cloudflare Secrets 中。

## 架构与 API

请求链：

```text
客户端 / ZCode
  -> Cloudflare Worker（鉴权、验证、IP HMAC、固定模型）
  -> 全局 SQLite-backed Durable Object（限流、额度、并发租约）
  -> Dify /v1/chat/completions
```

所有模型请求都访问同一个 Durable Object：

```ts
env.PROXY_LIMITER.getByName("global")
```

公开路由：

| 路由 | 鉴权 | 计数 | 说明 |
| --- | --- | --- | --- |
| `GET /` | 否 | 否 | 服务状态 |
| `GET /health` | 否 | 否 | 停用状态与模型名 |
| `GET /v1/models` | 否 | 否 | OpenAI-compatible 模型列表 |
| `POST /v1/chat/completions` | Bearer | 是 | Chat Completions 代理 |

客户端的 `model` 和 `n` 会分别被固定覆盖为 `MODEL_NAME` 和 `1`。其他正常 Chat Completions 字段保持原样，包括 `messages`、`tools`、`tool_choice`、`parallel_tool_calls`、`stream_options`、`reasoning_effort`、`response_format` 和多轮工具消息。

非流式响应按原始字节和 HTTP 状态码透传。SSE 不解析、不重组、不缓冲完整响应，因此 `reasoning_content`、`content`、`delta.tool_calls`、`function.arguments` 分片、`tool_call_id`、`finish_reason`、`usage` 和 `[DONE]` 均保持原样。

## 限流语义

默认限制由 [wrangler.jsonc](./wrangler.jsonc) 配置：

- 每个规范化 IP：每个 UTC 分钟最多 10 次。
- 每个 UTC 小时：最多准入 10 个不同 IP；已准入 IP 不重复占名额。
- 当前 `QUOTA_SCOPE`：全局最多 150 次。
- 所有请求：最多 3 个上游并发。
- 请求体最多 4 MiB，输出 token 参数最多 16384。

`acquire()` 在 Durable Object 的单个 `transactionSync` 事务中完成小时准入、RPM、当前 scope 全局计数和并发租约。任一检查失败会回滚整个事务，因此被拒请求不会误增其他计数。成功取得资格后，RPM 和全局计数不会因上游 4xx、5xx、网络失败或客户端断开而退还；并发租约会在请求结束时释放。

租约默认 TTL 为 180 秒，Worker 每 60 秒续租一次，续租覆盖等待首包、非流式正文读取和完整 SSE 生命周期。正常完成、失败或客户端取消时立即释放；Worker 意外终止时，租约会在 TTL 后失效并由后续请求清理。

每 6 小时会尽力清理超过 48 小时的分钟桶和小时准入记录。历史清理失败不会中断模型请求。

### 开启新一轮额度

全局计数按 `QUOTA_SCOPE` 隔离。Dify 额度进入新周期时，修改 [wrangler.jsonc](./wrangler.jsonc) 中的值，例如：

```jsonc
"QUOTA_SCOPE": "2026-09-share"
```

然后重新部署。新 scope 从 0 开始，旧 scope 保留，无需清库。不要在同一额度周期内随意改变 scope，否则会绕过预期的 150 次上限。

### 定时停用

可在 `vars` 中增加合法 ISO 8601 时间：

```jsonc
"DISABLE_AT": "2026-09-01T00:00:00Z"
```

到时后 Chat Completions 返回 503；`/health` 和 `/v1/models` 仍可访问。删除该变量并重新部署即可恢复。

## 配置

生产敏感变量必须使用 Wrangler Secrets，不要写入 Git：

| Secret | 说明 |
| --- | --- |
| `UPSTREAM_URL` | Dify 的完整 HTTPS `/v1/chat/completions` URL |
| `UPSTREAM_API_KEY` | Dify Endpoint Bearer Key |
| `GROUP_API_KEY` | 客户端共用的 Bearer Key |
| `IP_HMAC_SECRET` | 匿名化客户端 IP 的高熵 HMAC Secret |

普通变量及仓库默认值：

| 变量 | 默认值 |
| --- | ---: |
| `MODEL_NAME` | `claude-opus-4.6` |
| `PER_IP_RPM_LIMIT` | `10` |
| `HOURLY_UNIQUE_IP_LIMIT` | `10` |
| `GLOBAL_REQUEST_LIMIT` | `150` |
| `MAX_CONCURRENCY` | `3` |
| `LEASE_TTL_SECONDS` | `180` |
| `LEASE_HEARTBEAT_SECONDS` | `60` |
| `MAX_OUTPUT_TOKENS` | `16384` |
| `MAX_BODY_BYTES` | `4194304` |
| `QUOTA_SCOPE` | `2026-08-share` |
| `DISABLE_AT` | 未设置 |

数字变量必须是有效范围内的整数；heartbeat 必须小于 TTL。`UPSTREAM_URL` 只接受绝对 HTTPS URL，且路径必须以 `/v1/chat/completions` 结尾。

可生成足够长的共享 Key 和 HMAC Secret：

```bash
openssl rand -hex 32
```

## 本地开发

需要当前 LTS Node.js 和 npm。安装依赖：

```bash
npm ci
```

复制本地变量模板：

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入仅供本地开发的值，然后启动本地 Worker：

```bash
npm run dev
```

`.dev.vars` 已被 Git 忽略。不要在其中复用生产 Key。

运行 Workers / Durable Object 兼容测试和类型检查：

```bash
npm run check
```

单独命令：

```bash
npm run typecheck
npm test
npm run test:watch
npm run deploy:dry-run
```

## Cloudflare 部署

先检查代码：

```bash
npm ci
npm run check
npm run deploy:dry-run
```

登录 Cloudflare：

```bash
npx wrangler login
```

逐项设置生产 Secrets：

```bash
npx wrangler secret put UPSTREAM_URL
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler secret put GROUP_API_KEY
npx wrangler secret put IP_HMAC_SECRET
```

确认 [wrangler.jsonc](./wrangler.jsonc) 中的普通变量和 `QUOTA_SCOPE` 后部署：

```bash
npx wrangler deploy
```

部署后验证：

```bash
curl -i https://你的-worker.你的-subdomain.workers.dev/health
curl -i https://你的-worker.你的-subdomain.workers.dev/v1/models
```

本仓库使用 Wrangler 声明式 `exports` 创建 SQLite-backed Durable Object，没有旧式 migrations、D1 或外部 PostgreSQL。

### 轮换共享 Key

生成新 Key，更新 Cloudflare Secret：

```bash
openssl rand -hex 32
npx wrangler secret put GROUP_API_KEY
```

Secret 更新发布完成后，把新 Key 发给允许访问的调用者，并废弃旧 Key。轮换不会清除额度计数；要开启新额度周期，应单独修改 `QUOTA_SCOPE`。

## 调用示例

先设置本地 shell 变量：

```bash
export BASE_URL='https://你的-worker.你的-subdomain.workers.dev/v1'
export GROUP_API_KEY='替换为共享Key'
```

### 非流式

```bash
curl --fail-with-body \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $GROUP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "model": "claude-opus-4.6",
    "messages": [{"role": "user", "content": "只回复 OK"}],
    "max_tokens": 32,
    "stream": false
  }'
```

### SSE 流式

`--no-buffer` 避免 curl 自身缓冲：

```bash
curl --fail-with-body --no-buffer \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $GROUP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "model": "claude-opus-4.6",
    "messages": [{"role": "user", "content": "用两句话解释事务"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

### 两轮 function calling

第一轮请求工具调用：

```bash
curl --fail-with-body \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $GROUP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "messages": [{"role": "user", "content": "查询北京天气"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
    "stream": false
  }' > round1.json
```

从 `round1.json` 原样保留 assistant 的完整 `tool_calls`。假设真实响应中的 ID 为 `call_abc123`，第二轮结构如下；实际调用时不要改写响应中的 ID 或 arguments：

```bash
curl --fail-with-body \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $GROUP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "messages": [
      {"role": "user", "content": "查询北京天气"},
      {
        "role": "assistant",
        "content": null,
        "tool_calls": [{
          "id": "call_abc123",
          "type": "function",
          "function": {"name": "get_weather", "arguments": "{\"city\":\"北京\"}"}
        }]
      },
      {
        "role": "tool",
        "tool_call_id": "call_abc123",
        "content": "{\"temperature_c\":28,\"condition\":\"晴\"}"
      }
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "stream": false
  }'
```

## ZCode 配置

```text
Base URL:
https://你的-worker.你的-subdomain.workers.dev/v1

API Key:
GROUP_API_KEY 的实际值

API 格式:
Chat Completions (/chat/completions)

模型:
claude-opus-4.6
```

若修改 `MODEL_NAME`，ZCode 中也使用相同名称。

## 安全模型

- 生产只信任 Cloudflare 注入的 `CF-Connecting-IP`，不读取 `X-Forwarded-For` 或 `X-Real-IP`。
- IP 规范化后使用 HMAC-SHA256；SQLite 只保存完整 HMAC，日志只保存前 10 位。
- 共享 Key 先分别做 SHA-256，再对定长摘要执行完整 XOR 比较。
- 客户端 Authorization、Host、URL 或请求体中的 API Key 字段不能改变上游目标或认证。
- 上游只允许 HTTPS，不自动重试，不把上游 `Set-Cookie`、`Server` 等响应头传给客户端。
- 日志不包含原始 IP、请求正文、prompt、messages、tools、工具结果、响应正文、Secret 或上游 URL。
- `max_tokens` 与 `max_completion_tokens` 都受限制；两者同时出现时必须相等。

## 已知限制

- 所有流量串行经过一个全局 Durable Object 做短事务；这能保证计数原子性，适合本项目的小规模共享场景，不适合超高吞吐服务。
- 共用同一公网出口的用户会被视为同一 IP；VPN、移动网络切换和 IPv6 隐私地址可能改变身份哈希。
- 固定 UTC 分钟/小时桶在边界两侧可能产生短时突发。
- 全局额度只有管理员更改 `QUOTA_SCOPE` 后才恢复，因此该 429 不返回误导性的 `Retry-After`。
- 共享 Key 是访问控制边界；如怀疑泄漏，应立即轮换。
