# Dify OpenAI Chat Completions Proxy

面向少量熟人共享的轻量 OpenAI Chat Completions 反向代理。项目只提供 `/health`、`/v1/models` 和 `/v1/chat/completions`，没有注册、后台管理页面或动态 Key 管理。

运行环境：Node.js 22、TypeScript、Fastify、PostgreSQL，适配 Replit Autoscale 多实例。所有限流和并发状态都存放在 PostgreSQL；不使用 SQLite 或本地文件。

## 行为摘要

- 对外固定模型名，默认 `claude-opus-4.6`；客户端的 `model` 会被覆盖。
- 强制 `n: 1`；`max_tokens` 大于 16384 时返回 400，未提供时不会自动添加。
- 非流式响应按原始正文和状态码透传。
- SSE 使用字节流透传，不解析、不拼接、不重新序列化，保留 `reasoning_content`、`delta.content`、`delta.tool_calls`、工具参数分片、`finish_reason`、`usage` 和 `[DONE]`。
- 客户端断开会中止上游请求并释放并发租约。
- 只把固定 `UPSTREAM_URL` 和 `UPSTREAM_API_KEY` 用于上游；绝不转发客户端的认证头、Host 或自定义上游地址。
- IP 规范化后使用 HMAC-SHA256；数据库只保存完整哈希，审计日志只保存前 10 位。

## 数据库与原子策略

一次可访问上游的请求会在同一个 PostgreSQL 事务中依次完成：

1. 小时 IP 准入（事务级 advisory lock）。
2. 当前 UTC 分钟 RPM 原子 UPSERT。
3. 全局请求数原子递增。
4. 清理过期租约并取得并发租约（事务级 advisory lock）。

任意检查失败，整个事务回滚，因此不会留下错误的 RPM、全局计数或小时准入。事务提交后才调用上游；从上游调用开始，即使上游失败、超时或客户端断开，RPM 和全局请求数也不退还，只有并发租约会立即释放。

每 6 小时尝试清理超过 48 小时的分钟桶和小时准入记录。清理失败不会使模型请求失败。每次获取并发租约前都会清理过期租约。

## Replit 中添加 PostgreSQL Database

1. 打开 Replit 项目，在 Tools 中选择 **Database**。
2. 创建 PostgreSQL Database，并把它连接到当前项目。
3. 打开 **Secrets** 或 **Publishing → Edit Commands and Secrets**，确认存在 `DATABASE_URL`。不要把连接字符串写进代码、`.replit` 或 Git。
4. 在 Shell 中运行 `npm run migrate`。生产环境执行 `npm start` 时，也会在启动服务前自动运行编译后的迁移脚本。
5. 迁移是幂等的，多台 Autoscale 实例同时启动时会通过 PostgreSQL advisory lock 串行执行。

本地开发必须使用单独的 PostgreSQL 数据库：

```bash
export DATABASE_URL='postgresql://user:password@localhost:5432/dify_proxy_dev'
npm run migrate
npm run dev
```

集成测试必须使用可清空的独立测试库；测试会清空限流表：

```bash
export TEST_DATABASE_URL='postgresql://user:password@localhost:5432/dify_proxy_test'
npm test
```

不设置 `TEST_DATABASE_URL` 时，39 个无外部依赖的应用/协议测试照常运行，3 个真实 PostgreSQL 多实例竞争测试会跳过。

如果要开始一轮全新的共享额度，可在确认没有正在处理的请求后手动重置：

```sql
TRUNCATE ip_minute_usage, hourly_ip_admissions, concurrency_leases;
UPDATE global_usage
SET request_count = 0, updated_at = NOW()
WHERE scope = 'lifetime';
```

## Replit Secrets 清单

必须设置：

| Secret | 说明 |
| --- | --- |
| `UPSTREAM_URL` | Dify Endpoint 完整的 `/v1/chat/completions` URL。代理不会再拼接路径。 |
| `UPSTREAM_API_KEY` | Dify Endpoint Bearer Key。 |
| `GROUP_API_KEY` | 发给调用者的唯一共享 Key。 |
| `IP_HMAC_SECRET` | 足够长的随机 HMAC Secret。 |
| `DATABASE_URL` | Replit PostgreSQL 自动注入的连接字符串。 |

可选设置：

| Secret | 默认值 | 说明 |
| --- | ---: | --- |
| `MODEL_NAME` | `claude-opus-4.6` | 对外展示并强制使用的模型名。 |
| `PER_IP_RPM_LIMIT` | `10` | 每个 IP 每个 UTC 分钟的上限。 |
| `HOURLY_UNIQUE_IP_LIMIT` | `10` | 每个 UTC 小时允许的新 IP 数。 |
| `GLOBAL_REQUEST_LIMIT` | `150` | 数据库中本轮共享服务的总请求上限。 |
| `DISABLE_AT` | 空 | ISO 8601 时间，例如 `2026-08-01T12:00:00Z`。 |
| `MAX_CONCURRENCY` | `3` | 所有 Autoscale 实例合计并发上限。 |
| `LEASE_TTL_SECONDS` | `900` | 异常退出后租约自动失效时间。 |
| `PORT` | `3000` | Replit 通常自动注入；服务读取 `process.env.PORT`。 |
| `HOST` | `0.0.0.0` | 监听地址。Replit 必须使用 `0.0.0.0`。 |

可用以下命令生成 Key/Secret，结果只放进 Replit Secrets：

```bash
openssl rand -hex 32
```

## Replit Autoscale Publish 配置

1. Deployment 类型选择 **Autoscale**。
2. Build command：`npm run build`
3. Run command：`npm start`
4. 监听地址：`0.0.0.0`
5. 端口：由 `process.env.PORT` 提供，未提供时使用 3000。
6. 最小实例：`0`
7. 最大实例：建议 `2` 或 `3`
8. Health check path：`/health`
9. 把上面的 Secrets 添加到生产 Deployment，确认没有旧的未同步覆盖值。

`.replit` 已包含构建、启动和端口配置。Node.js 22 是 Replit 当前 Node 项目的运行时依赖，因此不需要 `replit.nix`。项目运行时不读写本地持久化文件。

发布后先检查：

```bash
curl -i https://你的-replit-域名/health
curl -i https://你的-replit-域名/v1/models
```

SSE 响应应立即逐块显示，响应头应包含：

```text
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

项目没有安装压缩插件，也不会设置 `Content-Encoding`。如果发布层仍缓冲，请检查 Replit/自定义域名前是否额外接入了会缓存或转换 SSE 的 CDN。

## 构建、测试和启动

```bash
npm install
npm run check
npm run migrate
npm run build
npm start
```

`npm run check` 会执行 TypeScript 编译和自动化测试。真实 PostgreSQL 竞争测试只有在提供 `TEST_DATABASE_URL` 时运行。

## curl：普通非流式请求

```bash
export BASE_URL='https://你的-replit-域名/v1'
export GROUP_API_KEY='替换为共享Key'

curl --fail-with-body --no-buffer \
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

## curl：普通流式请求

`--no-buffer`/`-N` 用于避免 curl 自己缓冲：

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

## curl：两轮 function calling

第一轮强制模型调用函数，并保存完整 `tool_calls`：

```bash
curl --fail-with-body \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $GROUP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "model": "claude-opus-4.6",
    "messages": [{"role": "user", "content": "查询北京天气"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
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

jq . round1.json
```

从 `round1.json` 原样取出 assistant 的 `tool_calls`。假设返回的 ID 是 `call_abc123`，第二轮必须使用同一个 `tool_call_id`：

```bash
curl --fail-with-body \
  "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $GROUP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "model": "claude-opus-4.6",
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
        "description": "查询城市天气",
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

不要手工改写真实响应中的 `tool_calls`、arguments 或 `tool_call_id`；上例只是结构示范。

## 限流测试方法

这些测试会消耗上游额度，建议使用独立测试数据库和 mock/低成本上游。

### RPM

把测试 Deployment 的 `PER_IP_RPM_LIMIT` 暂时设为 `2`，在同一个 UTC 分钟执行：

```bash
for i in 1 2 3; do
  curl -sS -D - -o /tmp/proxy-rpm-$i.json \
    "$BASE_URL/chat/completions" \
    -H "Authorization: Bearer $GROUP_API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary '{"messages":[{"role":"user","content":"只回复 OK"}],"max_tokens":8}'
done
```

第 3 次应返回 429、`Retry-After` 和 `per_ip_rpm_limit`。到下一个 UTC 分钟后应恢复。

### 每小时不同 IP

最可靠的方法是从 11 个真实公网出口调用测试 Deployment；前 10 个新 IP 应成功，第 11 个返回 429 和 `hourly_unique_ip_limit`，随后前 10 个中的任意一个仍应成功。

本地直连开发服务器时，也可用 11 个不同的 `X-Forwarded-For` 值做协议测试；公网 Replit 边缘可能会重写该头，因此不要把这种方法当作生产网络验证。仓库自动化测试已覆盖 10/11 IP 竞争和整点重置。

### 全局上限

使用新的测试数据库，把 `GLOBAL_REQUEST_LIMIT` 暂时设为 `2`，发送 3 个能够到达上游的请求。第 3 个应返回 429 和 `global_request_limit`，数据库中的计数仍为 2。恢复生产值前，请按数据库章节中的 SQL 重置测试数据库。

### 并发与多实例竞争

设置 `TEST_DATABASE_URL` 后运行：

```bash
npm test
```

测试会创建两个独立的 `PgQuotaStore`（两个连接池），验证第 10 个小时 IP 名额和最后一个全局名额不会被两个实例同时取得，并验证过期租约回收。

## ZCode 配置

```text
Base URL:
https://你的-replit-域名/v1

API Key:
GROUP_API_KEY 的实际值

API 格式:
Chat Completions (/chat/completions)

模型:
claude-opus-4.6
```

如果修改了 `MODEL_NAME`，ZCode 中的模型名也必须改为相同值。

## 安全与日志

- `GROUP_API_KEY` 使用先比长度、再 `crypto.timingSafeEqual` 的方式比较。
- 默认 Fastify 请求日志关闭，避免把认证头或请求正文写入日志。
- 审计日志只包含：时间、方法、路由、IP 哈希前 10 位、状态码、耗时、是否流式、错误类别、当前全局计数。
- 不记录原始 IP、Authorization、任何 Secret、数据库 URL、上游 URL、prompt、messages、tools、工具结果或上游响应正文。
- 所有普通响应设置 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和 `Cache-Control: no-store`；SSE 使用 `no-cache, no-transform`。

## 已知限制

- 共享同一公网出口的用户会被识别为同一 IP。
- VPN、移动网络切换和 IPv6 隐私地址可能改变用户 IP。
- 每小时不同 IP 限制是准入限制，不是身份认证；真正的访问控制仍依赖共享 Key。
- 固定 UTC 分钟桶在分钟边界可能允许短时间突发，例如上一分钟末尾和下一分钟开头各用满额度。
- 固定 UTC 小时桶会在每个整点同时重置。
- `GLOBAL_REQUEST_LIMIT` 存在 PostgreSQL 中，会跨 Autoscale 缩容、实例重启和重新发布保留；开始新的共享轮次时需要明确重置。
- 租约 TTL 是进程崩溃后的兜底。极端情况下，上游请求运行时间超过 TTL，租约可能先过期；默认 900 秒，应高于正常请求时长。
