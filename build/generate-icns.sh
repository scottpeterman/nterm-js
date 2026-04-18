#!/bin/bash
# generate-icns.sh — Run on macOS to create icon.icns from icon-1024.png
# Usage: cd build && bash generate-icns.sh

set -e

SOURCE="icon-1024.png"
ICONSET="nterm.iconset"

if [ ! -f "$SOURCE" ]; then
    echo "Error: $SOURCE not found. Run this from the build/ directory."
    exit 1
fi

echo "Creating iconset from $SOURCE..."
mkdir -p "$ICONSET"

sips -z 16 16       "$SOURCE" --out "$ICONSET/icon_16x16.png"
sips -z 32 32       "$SOURCE" --out "$ICONSET/icon_16x16@2x.png"
sips -z 32 32       "$SOURCE" --out "$ICONSET/icon_32x32.png"
sips -z 64 64       "$SOURCE" --out "$ICONSET/icon_32x32@2x.png"
sips -z 128 128     "$SOURCE" --out "$ICONSET/icon_128x128.png"
sips -z 256 256     "$SOURCE" --out "$ICONSET/icon_128x128@2x.png"
sips -z 256 256     "$SOURCE" --out "$ICONSET/icon_256x256.png"
sips -z 512 512     "$SOURCE" --out "$ICONSET/icon_256x256@2x.png"
sips -z 512 512     "$SOURCE" --out "$ICONSET/icon_512x512.png"
cp "$SOURCE"                       "$ICONSET/icon_512x512@2x.png"

echo "Converting iconset to icns..."
iconutil -c icns "$ICONSET" -o icon.icns

echo "Cleaning up iconset..."
rm -rf "$ICONSET"

echo "Done! icon.icns created ($(du -h icon.icns | cut -f1) bytes)"
