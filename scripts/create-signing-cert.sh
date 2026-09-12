#!/usr/bin/env bash
#
# 准备用于本地打包的 macOS 自签名代码签名身份（生成或恢复），并信任。
#
# 为什么需要它：Electron 打包默认使用 ad-hoc 签名，cdhash 每次构建都会变化，
# macOS 无法稳定识别应用，本地网络（mDNS）权限会被拒绝。使用固定身份的自签名
# 证书后，多次构建的签名身份一致，本地网络权限得以保留。
#
# 幂等：
#   - 身份已存在且受信任 → 直接复用；
#   - 身份不存在但 certs/ 里有密钥和证书 → 从文件恢复（不会更换证书）；
#   - 都没有 → 生成一套新的密钥和证书。
#
# 用法：
#   bash scripts/create-signing-cert.sh
#   CSC_NAME="My Local Cert" bash scripts/create-signing-cert.sh
#
# 注意：信任步骤可能弹出系统密码授权框，需输入 Mac 登录密码。

set -euo pipefail

CSC_NAME="${CSC_NAME:-AndDrive Self-Signed}"
CERT_DAYS="${CERT_DAYS:-3650}"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
CERT_DIR="${CERT_DIR:-certs}"
CERT_FILE="$CERT_DIR/self-signed.cert.pem"
KEY_FILE="$CERT_DIR/self-signed.key.pem"
P12_PASS="anddrive"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "仅支持 macOS" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t anddrive-cert)"
trap 'rm -rf "$TMP_DIR"' EXIT
P12_FILE="$TMP_DIR/cert.p12"

identity_present() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$CSC_NAME\""
}

identity_trusted() {
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null \
    | grep "\"$CSC_NAME\"" | grep -qv "CSSMERR"
}

export_p12() {
  local out="$1"
  openssl pkcs12 -export -legacy -out "$out" -inkey "$KEY_FILE" -in "$CERT_FILE" \
    -name "$CSC_NAME" -passout "pass:$P12_PASS" 2>/dev/null \
    || openssl pkcs12 -export -out "$out" -inkey "$KEY_FILE" -in "$CERT_FILE" \
      -name "$CSC_NAME" -passout "pass:$P12_PASS"
}

import_identity() {
  local p12="$1"
  security import "$p12" -k "$KEYCHAIN" -P "$P12_PASS" \
    -T /usr/bin/codesign -T /usr/bin/security -A
}

trust_identity() {
  echo "信任该证书用于代码签名（可能弹出系统授权框，请输入密码）"
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT_FILE" || {
    echo "用户级信任设置失败，尝试管理员域（需要 sudo）" >&2
    sudo security add-trusted-cert -d -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT_FILE"
  }
}

if identity_present; then
  echo "已存在代码签名身份：$CSC_NAME"
elif [[ -f "$KEY_FILE" && -f "$CERT_FILE" ]]; then
  echo "从已有文件恢复代码签名身份：$CSC_NAME"
  mkdir -p "$CERT_DIR"
  chmod 700 "$CERT_DIR"
  export_p12 "$P12_FILE"
  import_identity "$P12_FILE"
else
  if [[ -f "$CERT_FILE" && "${FORCE:-0}" != "1" ]]; then
    echo "检测到公开证书 ${CERT_FILE}，但没有对应的私钥 ${KEY_FILE}。" >&2
    echo "如果你只想运行/信任本仓库发布的 App，无需任何操作。" >&2
    echo "如果要生成你自己的签名证书（会替换仓库中的公开证书，导致信任该证书者需要重新信任），" >&2
    echo "请设置 FORCE=1 重新运行：FORCE=1 pnpm cert" >&2
    exit 1
  fi

  echo "生成自签名代码签名证书：$CSC_NAME"
  mkdir -p "$CERT_DIR"
  chmod 700 "$CERT_DIR"

  openssl req -x509 -newkey rsa:2048 -sha256 -days "$CERT_DAYS" -nodes \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -subj "/CN=$CSC_NAME/O=AndDrive Local/C=CN" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning"

  export_p12 "$P12_FILE"
  import_identity "$P12_FILE"
fi

if identity_trusted; then
  echo "证书已受信任，无需重复设置。"
else
  trust_identity
fi

echo
if identity_trusted; then
  echo "完成。可用代码签名身份："
  security find-identity -v -p codesigning "$KEYCHAIN" | grep "$CSC_NAME"
  echo
  echo "直接运行 pnpm build 即可使用该身份签名。"
else
  echo "无法找到受信任的代码签名身份，请检查钥匙串中的信任设置。" >&2
  exit 1
fi
