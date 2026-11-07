#!/bin/bash
# macOS 应用包后处理：
# 1. 注入本地网络权限声明（NSLocalNetworkUsageDescription / NSBonjourServices）
#    —— 缺少该声明时，macOS 26 会静默拒绝局域网访问且不弹授权窗（SSH 连不上、扫不到设备的根因）
# 2. ad-hoc 重新签名（plist 变更后签名失效）
# 用法: scripts/fix-macos-bundle.sh [app路径]
set -e

APP="${1:-src-tauri/target/release/bundle/macos/Glance IDE.app}"
PLIST="$APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "未找到 $PLIST"
  exit 1
fi

PB=/usr/libexec/PlistBuddy

$PB -c "Add :NSLocalNetworkUsageDescription string 'Glance IDE 需要访问本地网络以连接你的开发设备（SSH/SFTP/终端/设备发现）。'" "$PLIST" 2>/dev/null || echo "NSLocalNetworkUsageDescription 已存在"

$PB -c "Add :NSBonjourServices array" "$PLIST" 2>/dev/null || true
$PB -c "Add :NSBonjourServices:0 string _ssh._tcp" "$PLIST" 2>/dev/null || true
$PB -c "Add :NSBonjourServices:1 string _workstation._tcp" "$PLIST" 2>/dev/null || true

codesign --force -s - "$APP"
echo "✅ Info.plist 已注入本地网络声明并重新签名: $APP"
