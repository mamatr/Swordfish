#!/bin/bash
set -euo pipefail

# ============================================================
# Swordfish DMG Builder
# Fetches the latest release tag, builds, and creates a DMG
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RELEASE_BUILD_DIR="$SCRIPT_DIR/release-build"
STAGING="/tmp/swordfish-dmg-staging"
ICON_PNG="$SCRIPT_DIR/images/icon.png"
ICON_ICNS="$SCRIPT_DIR/images/icon.icns"

echo "=== Swordfish DMG Build ==="

# --- Step 0: Ensure we're on master before fetching ---
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
if [ "$CURRENT_BRANCH" != "master" ]; then
    echo "Switching to master branch..."
    git checkout master
fi

# --- Step 1: Fetch latest tags ---
echo "[1/7] Fetching latest tags..."
git fetch --tags

# --- Step 2: Get latest tag (fall back to HEAD if no tags) ---
LATEST_TAG=$(git tag --sort=-creatordate | head -1)
if [ -z "$LATEST_TAG" ]; then
    echo "[2/7] No tags found, using current master HEAD"
    git checkout master
    git pull origin master
else
    echo "[2/7] Latest release: $LATEST_TAG"

    # --- Step 3: Checkout the tag ---
    echo "[3/7] Checking out $LATEST_TAG..."
    git stash --quiet 2>/dev/null || true
    git checkout "$LATEST_TAG"
fi

# --- Step 4: Build Java backend ---
echo "[4/7] Building Java runtime image..."
gradle

# --- Step 5: Install npm deps and build TypeScript ---
echo "[5/7] Installing npm dependencies and building TypeScript..."
npm install
npm run build

# --- Step 6: Generate ICNS if needed ---
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

# --- Step 7: Package with Electron and create DMG ---
VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
echo "[6/7] Packaging Electron app for darwin arm64..."
npx electron-packager . Swordfish \
    --platform=darwin \
    --arch=arm64 \
    --overwrite \
    --out="$RELEASE_BUILD_DIR" \
    --icon="$ICON_ICNS"

DMG_NAME="Swordfish-${VERSION}-arm64.dmg"
DMG_PATH="$RELEASE_BUILD_DIR/$DMG_NAME"
APP_PATH="$RELEASE_BUILD_DIR/Swordfish-darwin-arm64/Swordfish.app"

echo "[7/7] Creating DMG..."
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
