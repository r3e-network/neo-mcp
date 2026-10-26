# Hetzner 生产部署指南 - neo-mcp

生产环境的实际形态：宿主机 Node + systemd 服务 + nginx TLS 反向代理。
**不是** Docker 部署，也**不要**用 `nohup` 启动（进程会在重启后消失，且无日志轮转）。

| 项目 | 值 |
| --- | --- |
| 主机 | `95.216.148.60` |
| 对外地址 | `https://mcp.n3index.dev/mcp` |
| 代码目录 | `/opt/neo-mcp` |
| systemd 单元 | `/etc/systemd/system/neo-mcp.service` |
| 环境变量文件 | `/etc/neo-mcp/env`（`600 root:root`） |
| 进程监听 | `127.0.0.1:3001`（只回环，外网只能经 nginx） |

## 1. systemd 单元

```ini
[Unit]
Description=Neo N3 MCP HTTP server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/neo-mcp
EnvironmentFile=/etc/neo-mcp/env
ExecStart=/usr/bin/node dist/mcp-http.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

启用（只需一次）：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now neo-mcp
```

## 2. 环境变量

`/etc/neo-mcp/env` 由 root 维护，权限必须是 `600`。生产上实际只有这四个变量，**值不写入仓库**：

```
NODE_ENV=production
MCP_HTTP_PORT=3001
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_BEARER=<secret>
```

变量名以 `resolveMcpHttpOptionsFromEnv()`（`src/mcp-http-server.ts`）为准，不是 `MCP_BEARER_SECRET`
之类的别名。其余可选项都有默认值，未设置时按默认走：`MCP_HTTP_PATH`（`/mcp`）、
`MCP_HTTP_ALLOWED_ORIGINS`、`MCP_HTTP_ALLOWED_HOSTS`、
`MCP_HTTP_MAX_CONCURRENT_REQUESTS`（128）、`MCP_HTTP_MAX_SUBSCRIPTIONS`（128）、
`MCP_HTTP_MAX_BODY_BYTES`（1048576）、`MCP_HTTP_BODY_TIMEOUT_MS`（30000）、
`MCP_HTTP_HEADERS_TIMEOUT_MS`（30000）、`MCP_HTTP_REQUEST_TIMEOUT_MS`（300000）、
`MCP_HTTP_KEEP_ALIVE_MS`（15000）、`LOG_LEVEL`、`NEO_NETWORK`、
`MAX_REQUESTS_PER_MINUTE`、`MAX_REQUESTS_PER_HOUR`、`HTTP_MAX_BODY_BYTES`。

`MCP_HTTP_HOST` 必须保持 `127.0.0.1`：TLS 与鉴权都在 nginx 之外没有第二层，直接暴露 3001 等于把
只读 MCP 面裸露在公网。代码本身也会兜底——`MCP_HTTP_HOST` 不是回环地址时，缺少 `MCP_HTTP_BEARER`
（或长度不足）会直接启动失败。

## 3. 发布新版本

**顺序不能改。** `npm run build` 的 `clean` 会**先删掉 `dist/`**，然后才用 `tsc` 编译，而
`typescript` 是 `devDependencies`。生产上 `node_modules` 是裁剪过的（只有生产依赖），所以
一旦跳过完整安装直接 build，就是先把正在跑的代码删掉、再以 `tsc: not found` 失败，服务只能对着
空的 `dist/` 反复重启；把同样两条命令再跑一遍当回滚也一样失败——缺的是编译器，不是版本。

```bash
ssh root@95.216.148.60
cd /opt/neo-mcp
git fetch origin --prune
git reset --hard origin/master     # /opt/neo-mcp 是部署检出，不保留本地改动

npm ci                             # 完整安装，dev 依赖提供 tsc
npm run build                      # clean + tsc，会重建 dist/
test -f dist/mcp-http.js           # 失败就停在这里：旧的 dist/ 已经没了
npm prune --omit=dev               # 回到只有生产依赖；dist/ 不受影响

sudo systemctl restart neo-mcp
journalctl -u neo-mcp -n 50 --no-pager
```

`Restart=always` 会掩盖启动期崩溃（服务看着在跑，其实在反复重启），所以 `journalctl` 这一步不能省。

不要写 `npm ci --omit=dev=false`：`--omit` 只接受 `dev|optional|peer`，npm 会报
`invalid config` 并忽略整个参数，看起来能用纯属巧合；而有人把它「修正」成 `--omit=dev`，
下一次 build 就会把生产打挂。要装全量就写裸的 `npm ci`。

## 4. nginx 与证书

TLS 在 nginx 终止，upstream 指回 `127.0.0.1:3001`；普通请求使用 `proxy_read_timeout 300s`，
`subscriptions/listen` 需要禁用响应缓冲并允许长连接。

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run       # 续期演练
```

## 5. 验证

```bash
# 服务状态与端口（3001 只应出现在 127.0.0.1 上）
systemctl is-active neo-mcp
systemctl is-enabled neo-mcp
ss -tlnp | grep 3001

# 对外端点：缺少 bearer 应返回 401，而不是 200
curl -si -X POST https://mcp.n3index.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -1
```

## 6. Vercel 侧

`Neo-Explorer-UI` 在**构建时**注入环境变量，改完必须重新部署才会生效：

```bash
vercel env ls                      # 只看变量名，值保持 Encrypted
# NEOX_MCP_URL   -> https://mcp.n3index.dev/mcp
# NEOX_MCP_BEARER-> 与 /etc/neo-mcp/env 里的 MCP_HTTP_BEARER 一致
```

`api/lib/mcpClient.js` 对所有非回环主机的明文 `http://` URL 直接失败（fail closed），
所以 `NEOX_MCP_URL` 留着旧的 `http://95.216.148.60:3001/mcp` 会让助手整体不可用。

## 7. 轮换 bearer

顺序不能颠倒，否则中间会出现一段 401 窗口：

1. 在 `/etc/neo-mcp/env` 写入新 `MCP_HTTP_BEARER`（保持 `600`）。
2. `sudo systemctl restart neo-mcp` 并查 `journalctl`。
3. 更新 Vercel 的 `NEOX_MCP_BEARER`。
4. 重新部署 `Neo-Explorer-UI`，再跑一次第 5 节的 401 检查与一次真实带工具调用的 `/api/agent` 请求。

任何进入过 `ps` 输出、日志或聊天记录的 bearer 都视为已泄露，按本节轮换。

## 8. 故障排查

| 现象 | 检查 |
| --- | --- |
| 助手 503 | `systemctl status neo-mcp`、`journalctl -u neo-mcp -n 100` |
| 助手 401 | Vercel `NEOX_MCP_BEARER` 与 `/etc/neo-mcp/env` 是否同值 |
| 助手报明文传输被拒 | `NEOX_MCP_URL` 是否仍是 `http://`，改为 `https://mcp.n3index.dev/mcp` 后重新部署 |
| 重启后服务消失 | `systemctl is-enabled neo-mcp` 应为 `enabled`；若为 `static`/`disabled`，重跑第 1 节 |
| nginx 502 | 进程是否在 `127.0.0.1:3001` 监听；`sudo tail -f /var/log/nginx/error.log` |
