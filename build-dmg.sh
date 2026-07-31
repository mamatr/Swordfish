#!/bin/bash
set -euo pipefail

# ============================================================
# Swordfish DMG Builder
# Builds from current HEAD, names DMG from latest upstream tag
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure JDK 26 is used (required for Java 25+ class files in upstream jars)
if [ -d "/opt/homebrew/Cellar/openjdk/26.0.1/libexec/openjdk.jdk/Contents/Home" ]; then
    export JAVA_HOME="/opt/homebrew/Cellar/openjdk/26.0.1/libexec/openjdk.jdk/Contents/Home"
    export PATH="$JAVA_HOME/bin:$PATH"
fi

RELEASE_BUILD_DIR="$SCRIPT_DIR/release-build"
STAGING="/tmp/swordfish-dmg-staging"
ICON_PNG="$SCRIPT_DIR/images/icon.png"
ICON_ICNS="$SCRIPT_DIR/images/icon.icns"
UPSTREAM_URL="https://github.com/maxprograms-com/Swordfish.git"

echo "=== Swordfish DMG Build ==="

# --- Step 1: Ensure upstream remote exists ---
if ! git remote get-url upstream &>/dev/null; then
    echo "[1/8] Adding upstream remote..."
    git remote add upstream "$UPSTREAM_URL"
else
    echo "[1/8] Upstream remote already configured"
fi

# --- Step 2: Fetch latest tags from both remotes ---
echo "[2/8] Fetching tags from origin and upstream..."
git fetch origin --tags --quiet
git fetch upstream --tags --quiet

# --- Step 3: Determine version string ---
LATEST_TAG=$(git tag --sort=-creatordate | head -1)
if [ -z "$LATEST_TAG" ]; then
    # No tags at all — fall back to package.json version
    VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
    echo "[3/8] No tags found, using package.json version: $VERSION"
else
    VERSION="${LATEST_TAG#v}"
    echo "[3/8] Latest tag: $LATEST_TAG (version: $VERSION)"
fi

# --- Step 4: Ensure we're building from current HEAD ---
echo "[4/8] Building from $(git rev-parse --short HEAD) on branch $(git branch --show-current)"

# --- Step 5: Build Java backend ---
echo "[5/8] Building Java runtime image..."
gradle

# --- Step 6: Install npm deps and build TypeScript ---
echo "[6/8] Installing npm dependencies and building TypeScript..."
npm install
npm run build

# --- Step 7: Generate ICNS if needed ---
if [ ! -f "$ICON_ICNS" ]; then
    echo "[*] Generating ICNS icon..."
    ICONSET="/tmp/swordfish-icon.iconset"
    rm -rf "$ICONSET"
    mkdir -p "$ICONSET"
    sips -z 16 16     "$ICON_PNG" --out "$ICONSET/icon_16x16.png" >/dev/null
    sips -z 32 32     "$ICON_PNG" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
    sips -z 32 32     "$ICON_PNG" --out "$ICONSET/icon_32x32.png" >/dev/null
    sips -z 64 64     "$ICON_PNG" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
    sips -z 128 128   "$ICON_PNG" --out "$ICONSET/icon_128x128.png" >/dev/null
    sips -z 256 256   "$ICON_PNG" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
    sips -z 256 256   "$ICON_PNG" --out "$ICONSET/icon_256x256.png" >/dev/null
    sips -z 512 512   "$ICON_PNG" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
    sips -z 512 512   "$ICON_PNG" --out "$ICONSET/icon_512x512.png" >/dev/null
    sips -z 1024 1024 "$ICON_PNG" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
    iconutil -c icns "$ICONSET" -o "$ICON_ICNS"
    rm -rf "$ICONSET"
fi

# --- Step 8: Package with Electron and create DMG ---
echo "[8/8] Packaging Electron app for darwin arm64..."
npx --yes @electron/packager . Swordfish \
    --platform=darwin \
    --arch=arm64 \
    --overwrite \
    --out="$RELEASE_BUILD_DIR" \
    --icon="$ICON_ICNS" \
    --ignore='^/\.claude' \
    --ignore='^/\.gradle' \
    --ignore='^/release-build' \
    --ignore='^/build' \
    --ignore='^/out' \
    --ignore='^/dist' \
    --ignore='^/jars/swordfish\.jar$' \
    --asar=false

DMG_NAME="Swordfish-${VERSION}-arm64.dmg"
DMG_PATH="$RELEASE_BUILD_DIR/$DMG_NAME"
APP_PATH="$RELEASE_BUILD_DIR/Swordfish-darwin-arm64/Swordfish.app"

echo "[8/8] Creating DMG..."
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$APP_PATH" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

rm -f "$DMG_PATH"
hdiutil create \
    -srcfolder "$STAGING" \
    -volname "Swordfish ${VERSION}" \
    -fs HFS+ \
    -format UDZO \
    "$DMG_PATH" >/dev/null

rm -rf "$STAGING"

# --- Done ---
DMG_SIZE=$(du -sh "$DMG_PATH" | cut -f1)
echo ""
echo "=== Done ==="
echo "DMG: $DMG_PATH"
echo "Size: $DMG_SIZE"
echo "Version: $VERSION"
