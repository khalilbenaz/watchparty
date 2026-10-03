#!/usr/bin/env bash
# Construit dist/watchparty-extension.zip à partir de extension/ (fichiers triés ; icône SVG source exclue).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/watchparty-extension.zip
( cd extension && find . -type f ! -name '.DS_Store' ! -name '*.svg' | LC_ALL=C sort | zip -X -q ../dist/watchparty-extension.zip -@ )
unzip -l dist/watchparty-extension.zip | tail -1
