#!/usr/bin/env bash
#
# 导出用于分发的自签名代码签名「公开证书」（不含私钥）。
#
# 接收方只需要安装这个 .crt 并信任，即可运行你用同一证书签名的 App。
# 私钥始终留在本机，不要外发。
#
# 用法：
#   bash scripts/export-signing-cert.sh [输出路径]
#   CSC_NAME="My Local Cert" bash scripts/export-signing-cert.sh dist/My.crt
#
# 默认输出：release/AndDrive-Signing.crt

set -euo pipefail

CSC_NAME="${CSC_NAME:-AndDrive Self-Signed}"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
CERT_SRC="${CERT_SRC:-certs/self-signed.cert.pem}"
OUT="${1:-release/AndDrive-Signing.crt}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "仅支持 macOS" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

if [[ -f "$CERT_SRC" ]]; then
  cp "$CERT_SRC" "$OUT"
else
  echo "未找到 ${CERT_SRC}，尝试从钥匙串导出：${CSC_NAME}"
  if ! security find-certificate -c "$CSC_NAME" -p "$KEYCHAIN" > "$OUT"; then
    echo "无法从钥匙串导出证书，请先运行 scripts/create-signing-cert.sh" >&2
    exit 1
  fi
fi

if ! openssl x509 -in "$OUT" -noout -subject >/dev/null 2>&1; then
  echo "导出的文件不是有效的 X.509 证书：$OUT" >&2
  exit 1
fi

echo "已导出公开证书：$OUT"
echo "指纹：$(openssl x509 -in "$OUT" -noout -fingerprint -sha256 | cut -d= -f2)"
echo
echo "把该文件连同 scripts/install-signing-cert.sh 一起发给接收方。"
echo "接收方运行：bash install-signing-cert.sh AndDrive-Signing.crt"
