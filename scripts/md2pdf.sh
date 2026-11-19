#!/usr/bin/env bash
# Builds one PDF from a Markdown document: pandoc turns it into a single HTML file with the style of
# docs/doc.css (images embedded, callouts by docs/doc.lua), headless Chrome prints it.
#   ./scripts/md2pdf.sh [--toc] IN.md OUT.pdf   (the Makefile does it for every document: make docs;
#                                               --toc adds a table of contents, see TOC_DOCS in the Makefile)
# Needs pandoc and google-chrome (or chromium) in PATH; relative images and links are resolved from the
# folder of IN.md, then from the repository root.
set -euo pipefail

toc=()
if [[ "${1:-}" == --toc ]]; then toc=(--toc --toc-depth=3); shift; fi
if [[ $# -ne 2 || "$1" == -h || "$1" == --help ]]; then
  echo "Usage: $0 [--toc] IN.md OUT.pdf" >&2
  [[ "${1:-}" == -h || "${1:-}" == --help ]] && exit 0
  exit 2
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
input="$(realpath -- "$1")"
output="$(realpath -m -- "$2")"
[[ -f "$input" ]] || { echo "No such file: $1" >&2; exit 2; }

chrome=''
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then chrome="$candidate"; break; fi
done
command -v pandoc >/dev/null 2>&1 || { echo 'pandoc is required (sudo apt install pandoc).' >&2; exit 1; }
[[ -n "$chrome" ]] || { echo 'google-chrome or chromium is required.' >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/md2pdf-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
name="$(basename -- "$input" .md)"

cd -- "$(dirname -- "$input")"
pandoc "$input" --from=gfm+footnotes --to=html5 --standalone --embed-resources "${toc[@]}" \
  --resource-path "$(dirname -- "$input"):$root" --css "$root/docs/doc.css" \
  --lua-filter "$root/docs/doc.lua" --no-highlight --metadata "pagetitle=$name" \
  --output "$work/doc.html"

mkdir -p -- "$(dirname -- "$output")"
"$chrome" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="$work/profile" \
  --no-first-run --print-to-pdf="$output" "file://$work/doc.html" >/dev/null 2>&1
[[ -s "$output" ]] || { echo "Chrome did not write $output" >&2; exit 1; }
echo "Created ${output#"$root"/}"
