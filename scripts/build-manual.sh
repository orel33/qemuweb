#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

html_file=$(mktemp "$project_root/docs/.manual-XXXXXX.html")
trap 'rm -f "$html_file"' EXIT HUP INT TERM

pandoc docs/manual.md --from=markdown+raw_html --to=html5 --standalone \
  --embed-resources --css docs/manual.css --output "$html_file"

wkhtmltopdf --quiet --enable-local-file-access --page-size A4 \
  --margin-top 18mm --margin-bottom 18mm --margin-left 17mm --margin-right 17mm \
  "$html_file" docs/manual.pdf

printf 'Created %s\n' "$project_root/docs/manual.pdf"
