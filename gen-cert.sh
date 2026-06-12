#!/bin/sh
# 生成自签名证书用于 HTTPS（无域名/IP-only 场景；有域名请改用 Let's Encrypt 等真实证书）
# 用法: sh gen-cert.sh [服务器IP或主机名]   不填默认 localhost
#   PLAZA_TLS_KEY=$PWD/certs/key.pem PLAZA_TLS_CERT=$PWD/certs/cert.pem node server.js
set -e
HOST="${1:-localhost}"
mkdir -p certs
# 把传入的 HOST 同时写进 CN 和 SAN（IP 或域名都兼容）
case "$HOST" in
  *[0-9].[0-9]*) SAN="IP:$HOST,IP:127.0.0.1,DNS:localhost" ;;
  *)             SAN="DNS:$HOST,DNS:localhost,IP:127.0.0.1" ;;
esac
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem -days 365 \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=$SAN"
chmod 600 certs/key.pem
echo "已生成 certs/key.pem 与 certs/cert.pem (CN=$HOST, SAN=$SAN)"
echo "启动 HTTPS:"
echo "  PLAZA_TLS_KEY=\$PWD/certs/key.pem PLAZA_TLS_CERT=\$PWD/certs/cert.pem node server.js"
echo "自签名证书客户端需放行: PLAZA_URL=https://localhost:8500 PLAZA_INSECURE=1 node plaza.js board"
