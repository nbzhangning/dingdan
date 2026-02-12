# 云服务器部署说明

本文提供两种部署方式：`systemd`（推荐）和 `Docker`。

## 0. 前置条件
- 云服务器 Linux（Ubuntu/CentOS 均可）。
- 安全组放行端口：`3330`（服务）与 `22`（SSH）。
- 已安装 Node.js 18+（systemd 方式）或 Docker（Docker 方式）。

---

## 1. 一键脚本部署（systemd）

本仓库已提供脚本：`deploy/cloud-deploy.sh`。

### 本地执行
```bash
SERVER_IP=你的云服务器IP SERVER_USER=root ./deploy/cloud-deploy.sh
```

可选变量：
- `SERVER_PATH`：代码目录（默认 `/opt/dingdan`）
- `SSH_PORT`：SSH 端口（默认 `22`）

脚本会自动完成：
1) rsync 同步代码
2) `npm ci --omit=dev`
3) 安装 `deploy/dingdan.service`
4) `systemctl enable/restart`

### 查看状态
```bash
ssh root@你的IP 'systemctl status dingdan --no-pager'
ssh root@你的IP 'journalctl -u dingdan -n 200 --no-pager'
curl http://你的IP:3330/health
```

---

## 2. Docker 部署

### 在服务器执行
```bash
cd /opt/dingdan
docker build -t dingdan:latest .
docker run -d --name dingdan \
  --restart=always \
  -p 3330:3330 \
  -e PORT=3330 \
  -e ERP_TARGET_URL='http://172.16.24.216:5030/receive_data' \
  -e ERP_STRICT_MODE=1 \
  -e ERP_RETRY_ENABLED=1 \
  -e ERP_RETRY_MAX_ATTEMPTS=3 \
  -e ERP_RETRY_DELAY_MS=30000 \
  -v /opt/dingdan/data:/app/data \
  dingdan:latest
```

### 验证
```bash
docker logs --tail 200 dingdan
curl http://你的IP:3330/health
```

---

## 3. 常见问题

### 3.1 端口不通
- 检查安全组/防火墙是否放行 `3330`。
- `ss -lntp | grep 3330` 确认监听。

### 3.2 ERP 不可达
- 若出现 `ENETUNREACH/ETIMEDOUT`，优先排查云服务器到 ERP 内网地址的路由。
- 如需严格失败语义，开启 `ERP_STRICT_MODE=1`。

### 3.3 用户数据/商品数据持久化
- 所有 JSON 数据在 `data/` 目录。
- 生产建议定时备份 `/opt/dingdan/data`。
