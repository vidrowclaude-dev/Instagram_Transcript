#!/bin/bash
# Build dist/Vidrow_Edit_Kit.zip: extension + installer + README.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/check-jsx.js
rm -rf dist && mkdir -p dist/Vidrow_Edit_Kit
cp -R extension dist/Vidrow_Edit_Kit/co.vidrow.editkit
cp "Install Vidrow Edit Kit.command" README.md dist/Vidrow_Edit_Kit/
chmod +x "dist/Vidrow_Edit_Kit/Install Vidrow Edit Kit.command"
find dist -name '.DS_Store' -delete
(cd dist && zip -qr -X Vidrow_Edit_Kit.zip Vidrow_Edit_Kit)
rm -rf dist/Vidrow_Edit_Kit
ls -lh dist/Vidrow_Edit_Kit.zip
