#!/usr/bin/env bash
#
# 接收方一键安装并信任 AndDrive 的本地自签名证书（公开证书，不含私钥）。
#
# 作用：让 macOS 信任用该证书签名的 App，从而通过 Gatekeeper，
# 并让「本地网络」权限获得稳定的签名身份（这是连接 Android 设备所必需的）。
#
# 用法：
#   bash install-signing-cert.sh AndDrive-Signing.crt
#   bash install-signing-cert.sh AndDrive-Signing.crt --app "/Applications/AndDrive Beta.app"
#
# 参数：
#   <证书文件>            必需，PEM 或 DER 格式的 X.509 证书
#   --app <App 路径>      可选，自动去掉该 App 的 quarantine 隔离属性
#
# 环境变量：
#   KEYCHAIN              默认登录钥匙串

set -euo pipefail

CERT_FILE=""
APP_PATH=""
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_PATH="${2:-}"
      if [[ -z "$APP_PATH" ]]; then
        echo "--app 需要一个 App 路径" >&2
        exit 1
      fi
      shift 2
      ;;
    -*)
      echo "未知参数：$1" >&2
      exit 1
      ;;
    *)
      CERT_FILE="$1"
      shift
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "仅支持 macOS" >&2
  exit 1
fi

if [[ -z "$CERT_FILE" ]]; then
  for candidate in AndDrive-Signing.crt AndDrive-Signing.pem self-signed.cert.pem certs/self-signed.cert.pem; do
    if [[ -f "$candidate" ]]; then
      CERT_FILE="$candidate"
      break
    fi
  done
fi

if [[ -z "$CERT_FILE" || ! -f "$CERT_FILE" ]]; then
  echo "未找到证书文件。用法：bash install-signing-cert.sh AndDrive-Signing.crt" >&2
  exit 1
fi

if ! openssl x509 -in "$CERT_FILE" -noout -subject >/dev/null 2>&1; then
  echo "不是有效的 X.509 证书：$CERT_FILE" >&2
  exit 1
fi

SUBJECT="$(openssl x509 -in "$CERT_FILE" -noout -subject | sed 's/^subject=//')"
echo "安装证书：$SUBJECT"

echo "导入到登录钥匙串：${KEYCHAIN}"
security import "$CERT_FILE" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security

echo "信任该证书用于代码签名（可能弹出系统授权框，请输入密码）"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT_FILE" || {
  echo "用户级信任设置失败，尝试管理员域（需要 sudo）" >&2
  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT_FILE"
}

if [[ -n "$APP_PATH" ]]; then
  if [[ -e "$APP_PATH" ]]; then
    echo "移除隔离属性：$APP_PATH"
    xattr -dr com.apple.quarantine "$APP_PATH" || true
  else
    echo "提示：未找到 App 路径，跳过去隔离：$APP_PATH" >&2
  fi
fi

echo
echo "完成。"
echo "- 若 App 仍被 Gatekeeper 拦截：在 Finder 中右键 App → 打开，或手动执行"
echo "    xattr -dr com.apple.quarantine \"/Applications/AndDrive Beta.app\""
echo "- 首次连接设备时，系统会弹出「本地网络」授权，请点击允许。"
