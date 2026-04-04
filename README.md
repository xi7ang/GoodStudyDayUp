# GoodStudyDayUpBot - Telegram Bot

这是一个基于 Cloudflare Workers 的 Telegram Bot 后台服务，用于查询和分享资源信息。

## 功能特性

- 🤖 处理 Telegram Bot webhook 请求
- 💾 集成 Cloudflare D1 数据库
- 🔍 根据资源 ID 查询并返回资源详情
- 📱 支持深链接访问：`https://t.me/GoodStudyDayUpBot?start=资源ID`

## 项目结构

```
pansoTGbot/
├── src/
│   └── index.js          # Worker 主代码
├── schema.sql            # D1 数据库表结构
├── wrangler.toml         # Cloudflare Worker 配置
├── package.json          # 项目依赖
└── README.md             # 项目说明
```

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 D1 数据库

```bash
# 创建数据库
npx wrangler d1 create pandata_db

# 记录输出中的 database_id，更新到 wrangler.toml 文件中
```

将输出的 `database_id` 替换到 [wrangler.toml](wrangler.toml#L7) 中的 `your-database-id-here`。

### 3. 初始化数据库表结构

```bash
# 执行 schema.sql 创建表
npx wrangler d1 execute pandata_db --file=./schema.sql
```

### 4. 设置环境变量

```bash
# 设置 Telegram Bot Token（从 @BotFather 获取）
npx wrangler secret put TELEGRAM_BOT_TOKEN
# 按提示输入你的 bot token
```

### 5. 部署 Worker

```bash
npm run deploy
```

部署成功后，你的 Worker 将运行在：
`https://goodstudydayupbot-telegram-bot.wsheng-980210.workers.dev`

### 6. 设置 Telegram Webhook

```bash
# 将你的 Worker URL 设置为 Telegram webhook
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://goodstudydayupbot-telegram-bot.wsheng-980210.workers.dev/webhook"}'
```

将 `<YOUR_BOT_TOKEN>` 替换为你的实际 bot token。

## 数据库管理

### 查看数据

```bash
npx wrangler d1 execute pandata_db --command="SELECT * FROM pandata"
```

### 插入测试数据

```bash
npx wrangler d1 execute pandata_db --command="
INSERT INTO pandata (resource_name, resource_description, resource_link, resource_hint)
VALUES ('示例资源', '这是一个示例资源', 'https://example.com', '使用前请阅读说明')
"
```

### 删除数据

```bash
npx wrangler d1 execute pandata_db --command="DELETE FROM pandata WHERE id = 1"
```

## 使用方法

### 用户访问流程

1. 用户点击链接：`https://t.me/GoodStudyDayUpBot?start=123`
   - `123` 是资源在数据库中的 ID

2. Bot 自动查询数据库并返回格式化的资源信息：
   ```
   📚 资源信息

   📌 资源名称：示例资源

   📝 资源描述：
   这是一个示例资源的详细描述

   🔗 资源链接：
   https://example.com/resource

   💡 使用提示：
   使用前请先阅读使用说明
   ```

## 本地开发

```bash
# 启动本地开发服务器
npm run dev
```

本地开发时，Worker 运行在 `http://localhost:8787`。

**注意**：本地开发时需要配置本地 D1 数据库。

## API 端点

- `GET /health` - 健康检查
- `POST /webhook` - Telegram webhook 接收端点

## 环境变量

| 变量名 | 说明 | 设置方式 |
|--------|------|----------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot 令牌 | `npx wrangler secret put TELEGRAM_BOT_TOKEN` |

## 数据库表结构

### pandata 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| resource_name | TEXT | 资源名称 |
| resource_description | TEXT | 资源描述 |
| resource_link | TEXT | 资源链接 |
| resource_hint | TEXT | 使用提示 |
| created_at | TIMESTAMP | 创建时间 |
| updated_at | TIMESTAMP | 更新时间 |

## 故障排查

### 1. Bot 无响应

- 检查 webhook 是否正确设置
- 查看 Worker 日志：`npx wrangler tail`
- 确认 `TELEGRAM_BOT_TOKEN` 已正确设置

### 2. 数据库查询失败

- 确认 D1 数据库已创建并绑定
- 检查 [wrangler.toml](wrangler.toml#L7) 中的 `database_id` 是否正确
- 确认数据表已创建：`npx wrangler d1 execute pandata_db --command="SELECT * FROM pandata LIMIT 1"`

### 3. 查看日志

```bash
# 实时查看 Worker 日志
npx wrangler tail
```

## 技术栈

- Cloudflare Workers - 无服务器计算平台
- Cloudflare D1 - SQLite 数据库
- Telegram Bot API - 机器人接口

## 许可证

MIT
