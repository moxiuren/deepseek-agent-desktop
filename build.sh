#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "==> 1. 生成 App 图标..."
if [ ! -f "AppIcon.icns" ]; then
    swiftc -O build_icon.swift -o build_icon
    ./build_icon
    iconutil -c icns AppIcon.iconset -o AppIcon.icns
fi

APP_BUNDLE="DeepSeek.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "==> 2. 创建应用目录结构..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

echo "==> 3. 编译 Swift 原生二进制..."
swiftc -O -target arm64-apple-macos12.0 main.swift -o "$MACOS_DIR/DeepSeek"

echo "==> 4. 拷贝资源与元数据..."
cp Info.plist "$CONTENTS_DIR/Info.plist"
cp AppIcon.icns "$RESOURCES_DIR/AppIcon.icns"
cp agent_bridge.js "$RESOURCES_DIR/agent_bridge.js"
echo "APPL????" > "$CONTENTS_DIR/PkgInfo"

echo "==> 5. 本地安全签名 (Ad-hoc)..."
codesign --force --deep --sign - "$APP_BUNDLE"

echo "==> 6. 安装到 /Applications..."
rm -rf "/Applications/DeepSeek.app"
cp -R "$APP_BUNDLE" "/Applications/DeepSeek.app"

echo "==> 7. 安装辅助 CLI (agent-screenshot, agent-attach)..."
mkdir -p "$HOME/.local/bin"
cp scripts/agent-screenshot "$HOME/.local/bin/agent-screenshot" 2>/dev/null || true
cp scripts/agent-attach "$HOME/.local/bin/agent-attach" 2>/dev/null || true
chmod +x "$HOME/.local/bin/agent-screenshot" "$HOME/.local/bin/agent-attach" 2>/dev/null || true

echo "==> 构建成功！应用已安装到 /Applications/DeepSeek.app"
