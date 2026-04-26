#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("manifest.json", "utf8")).version)')"
PACKAGE_NAME="bilibili-subtitle-transcript-${VERSION}.zip"

node scripts/generate-icons.mjs
rm -rf dist
mkdir -p dist

zip -qr "dist/${PACKAGE_NAME}" \
  manifest.json \
  background.js \
  content-script.js \
  popup.html \
  popup.css \
  popup.js \
  icons

echo "Created dist/${PACKAGE_NAME}"
