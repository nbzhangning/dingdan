#!/usr/bin/env bash
set -euo pipefail

# 用法：
# SERVER_IP=1.2.3.4 SERVER_USER=root ./deploy/cloud-deploy.sh
# 可选：SERVER_PATH=/opt/dingdan SSH_PORT=22

: "${SERVER_IP:?请设置 SERVER_IP}"
: "${SERVER_USER:=root}"
: "${SERVER_PATH:=/opt/dingdan}"
: "${SSH_PORT:=22}"

SSH_TARGET="${SERVER_USER}@${SERVER_IP}"

echo "[1/6] 打包并同步代码到服务器 ${SSH_TARGET}:${SERVER_PATH}"
ssh -p "${SSH_PORT}" "${SSH_TARGET}" "mkdir -p ${SERVER_PATH}"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '*.log' \
  -e "ssh -p ${SSH_PORT}" \
  ./ "${SSH_TARGET}:${SERVER_PATH}/"

echo "[2/6] 安装 Node.js 依赖"
ssh -p "${SSH_PORT}" "${SSH_TARGET}" "cd ${SERVER_PATH} && npm ci --omit=dev"

echo "[3/6] 准备数据目录"
ssh -p "${SSH_PORT}" "${SSH_TARGET}" "mkdir -p ${SERVER_PATH}/data"

echo "[4/6] 安装 systemd 服务"
ssh -p "${SSH_PORT}" "${SSH_TARGET}" "cp ${SERVER_PATH}/deploy/dingdan.service /etc/systemd/system/dingdan.service"

echo "[5/6] 启动并设置开机自启"
ssh -p "${SSH_PORT}" "${SSH_TARGET}" "systemctl daemon-reload && systemctl enable dingdan && systemctl restart dingdan"

echo "[6/6] 输出服务状态"
ssh -p "${SSH_PORT}" "${SSH_TARGET}" "systemctl --no-pager --full status dingdan | sed -n '1,40p'"

echo "部署完成。健康检查：curl http://${SERVER_IP}:3330/health"
