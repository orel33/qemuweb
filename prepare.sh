#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Use the system IDs from config.json so each configured OS has one matching
# preparation script, named scripts/prepare/<system-id>.sh.
mapfile -t system_ids < <(node - "$ROOT/config.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const id of Object.keys(config.systems)) console.log(id);
NODE
)

for id in "${system_ids[@]}"; do
  script="$ROOT/scripts/prepare/$id.sh"
  if [[ ! -x "$script" ]]; then
    echo "Missing executable preparation script for systems.$id: $script" >&2
    exit 1
  fi
  "$script"
done

# Fail early if a preparation script did not produce both image formats
# expected by the application configuration.
node - "$ROOT/config.json" "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [id, system] of Object.entries(config.systems)) {
  for (const format of ['raw', 'vdi']) {
    const file = path.resolve(process.argv[3], system.images[format]);
    if (!fs.existsSync(file)) throw new Error(`Missing ${format} image for ${id}: ${file}`);
  }
}
NODE

echo "Prepared all configured system images."
