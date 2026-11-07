#!/bin/bash
# cargo runner（macOS dev）：编译产物 ad-hoc 签名后运行。
# 背景：macOS 26 本地网络隐私权限按代码签名归属判定，未签名二进制连局域网设备
# 被静默拒绝（No route to host）。每次 cargo/tauri 重编译都会覆盖签名，故用 runner 兜底。
BIN="$1"
shift
codesign -s - "$BIN" 2>/dev/null || true
exec "$BIN" "$@"
