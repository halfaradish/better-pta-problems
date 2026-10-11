# 题目集关闭邮件提醒 · 后端

「更好的题目集」浏览器插件的配套后端：接收插件上报的未关闭题目集订阅，在每门课截止前（默认提前 **3 天**和 **1 天**）各发一封提醒邮件到你的邮箱。

```
PTA「进行中」页面（插件聚合未关闭题目集）
  └─ 打开页面时自动 POST /api/subscriptions { email, sets }
       └─ 本服务：SQLite 存订阅 → 每分钟扫描 → SMTP 发提醒邮件
```

## 依赖

- **Node ≥ 22.5**（数据库用内置的 `node:sqlite`，无需安装任何数据库；22.x 会打印一条实验特性警告，无碍）
- 推荐用 Docker（见下），可完全无视 Node 版本问题

## 快速开始

```bash
npm install
cp .env.example .env
vim .env          # 填 SMTP 发信账号
node index.js     # 或 npm start
```

### 获取 SMTP 授权码（以 QQ 邮箱为例）

1. 登录 [mail.qq.com](https://mail.qq.com) → 设置 → 账号；
2. 找到「POP3/IMAP/SMTP 服务」，开启「SMTP 服务」，按提示用手机短信获取**授权码**；
3. `.env` 中填：`SMTP_HOST=smtp.qq.com`、`SMTP_PORT=465`、`SMTP_USER=你的QQ邮箱`、`SMTP_PASS=授权码`。

163 邮箱同理（`smtp.163.com:465`）。注意密码栏填的是**授权码**，不是邮箱登录密码。

## 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 监听端口 |
| `DB_FILE` | `./data.db` | SQLite 数据文件路径 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | — / `465` / `1` | SMTP 服务器 |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP 账号 / 授权码 |
| `MAIL_FROM` | `SMTP_USER` | 发件人显示地址 |
| `REMIND_BEFORE_MINUTES` | `4320,1440` | 截止前多少分钟提醒，逗号分隔（默认 3 天 / 1 天） |
| `CHECK_INTERVAL_SECONDS` | `60` | 调度检查间隔 |
| `GRACE_MINUTES` | `120` | 补发宽限：触发点已过超过该时长就不再补发（防宕机恢复后陈旧轰炸） |
| `DISPLAY_TZ` | `Asia/Shanghai` | 邮件里时间的显示时区 |
| `TOKEN` | 空 | 访问令牌，见下方「安全」 |
| `DRY_RUN` | 空 | `1` = 只把邮件打印到日志，不真发 |

## 部署

### systemd

```bash
sudo mkdir -p /opt/better-pta-reminder
sudo rsync -a --exclude node_modules --exclude .env --exclude data.db ./ /opt/better-pta-reminder/
cd /opt/better-pta-reminder && sudo npm install --omit=dev
sudo cp .env.example .env && sudo vim .env
sudo cp better-pta-reminder.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now better-pta-reminder
journalctl -u better-pta-reminder -f
```

### Docker

```bash
docker build -t better-pta-reminder .
docker run -d --name better-pta-reminder \
  -p 8787:8787 \
  -v "$PWD/data:/app/data" \
  --env-file .env \
  --restart unless-stopped \
  better-pta-reminder
```

数据落在挂载的 `./data/data.db`，升级镜像不丢数据。

## 安全

- 接口收到订阅后会**以你的 SMTP 账号向任意邮箱发信**，公网裸奔有被当垃圾邮件中继的风险；
- 防火墙只对可信来源开放端口，或设置 `TOKEN=随机字符串`；
- 设置 `TOKEN` 后，插件里的服务器地址要写成 `ip:port/令牌`（例如 `1.2.3.4:8787/my-token`），令牌会以 `X-Token` 头透传；
- `data.db` 含订阅邮箱与题目集列表，注意备份与权限。

## 验证

1. **不真发先看效果**：`DRY_RUN=1 node index.js`，另开终端：
   ```bash
   curl http://127.0.0.1:8787/healthz
   curl -X POST http://127.0.0.1:8787/api/test -H 'Content-Type: application/json' -d '{"email":"me@example.com"}'
   ```
   日志应打印邮件内容；
2. **端到端看到真邮件**：`.env` 填好 SMTP 后，临时设 `REMIND_BEFORE_MINUTES=5` 重启，再提交一个「6 分钟后关闭」的订阅：
   ```bash
   curl -X POST http://127.0.0.1:8787/api/subscriptions -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","sets":[{"id":"999001","title":"验证用题目集","endAt":"'$(date -u -d '+6 minutes' +%Y-%m-%dT%H:%M:%SZ)'"}]}'
   ```
   一分钟后日志出现 `[sent]`，邮箱收到提醒（验证完把 `REMIND_BEFORE_MINUTES` 改回 `4320,1440`）；
3. **连上插件**：浏览器装好扩展 → 插件弹窗填服务器地址和邮箱 → 点「发送测试邮件」→ 打开 `pintia.cn/problem-sets/active`，日志出现订阅上报。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 健康检查：`{ok, emails, sets}` |
| `POST` | `/api/subscriptions` | 全量替换某邮箱的订阅：`{email, sets:[{id,title,endAt,owner,org}]}`，`endAt` 为 ISO 时间或 epoch ms |
| `POST` | `/api/test` | 给 `{email}` 立即发一封测试邮件 |

所有响应带 `Access-Control-Allow-Origin: *`（扩展 background 跨源调用所需）；配置了 `TOKEN` 时 `/api/*` 要求 `X-Token` 请求头。
