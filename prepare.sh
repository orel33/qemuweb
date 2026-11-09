#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<'HELP'
Usage: bash prepare.sh [--all | --system <sysname>] [--force]
       bash prepare.sh --list
       bash prepare.sh --help

Prepare every system by default. For each system:
  1. Fetch and verify sources in sources/<sysname>/.
  2. Build images/<sysname>.raw and images/<sysname>.vdi.
The elapsed time of each step and the system total are displayed.

--list             List systems, allocated image disk usage (GB), and date.
--all              Prepare every configured system (the default).
--system <sysname> Prepare one configured system.
--force            Rebuild and replace existing images. Save the old pair in
                   images/backups/ for recovery. Running VMs and old working
                   disks may become incompatible with the new base.
HELP
}

fail() { echo "prepare.sh: $*" >&2; exit 2; }

format_duration() {
  local seconds="$1"
  printf '%02d:%02d:%02d' "$((seconds / 3600))" "$(((seconds / 60) % 60))" "$((seconds % 60))"
}

selected_system=''
explicit_all=false
list_only=false
force=false
while (( $# )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --list) list_only=true; shift ;;
    --all)
      [[ -z "$selected_system" && "$explicit_all" == false ]] || fail 'Choose --all or one --system.'
      explicit_all=true; shift ;;
    --system)
      [[ "$explicit_all" == false && -z "$selected_system" && $# -ge 2 ]] || fail 'Expected one system ID after --system.'
      [[ -n "$2" && "$2" != --* ]] || fail 'Expected one system ID after --system.'
      selected_system="$2"; shift 2 ;;
    --force) force=true; shift ;;
    *) fail "Unknown option: $1 (see --help)." ;;
  esac
done

if [[ "$list_only" == true && ( "$explicit_all" == true || -n "$selected_system" || "$force" == true ) ]]; then
  fail '--list cannot be combined with preparation options.'
fi

config_ids=$(node - "$ROOT/config.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ids = Object.keys(config.systems || {});
if (!ids.length) throw new Error('No systems declared in config.json.');
for (const id of ids) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Unsafe system ID in config.json: ${id}`);
  console.log(id);
}
NODE
)
mapfile -t system_ids <<< "$config_ids"
if [[ "$list_only" == true ]]; then
  node - "$ROOT/config.json" "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [configFile, root] = process.argv.slice(2);
const systems = JSON.parse(fs.readFileSync(configFile, 'utf8')).systems;
const heading = ['System', 'RAW GB', 'VDI GB', 'Total GB', 'Built (local time)'];
const rows = [heading];
for (const [id, system] of Object.entries(systems)) {
  const stats = ['raw', 'vdi'].map(format => {
    try { return fs.statSync(path.resolve(root, system.images[format])); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  });
  const gb = stat => stat ? (stat.blocks * 512 / 1e9).toFixed(2) : '-';
  const latest = Math.max(...stats.filter(Boolean).map(stat => stat.mtimeMs), 0);
  const built = latest ? new Date(latest).toLocaleString('sv-SE', {hour12: false}) : '-';
  const total = stats.some(Boolean) ? (stats.reduce((bytes, stat) => bytes + (stat?.blocks || 0) * 512, 0) / 1e9).toFixed(2) : '-';
  rows.push([id, gb(stats[0]), gb(stats[1]), total, built]);
}
const widths = heading.map((_, index) => Math.max(...rows.map(row => row[index].length)));
for (const row of rows) console.log(row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd());
NODE
  exit 0
fi

target_ids=("${system_ids[@]}")
if [[ -n "$selected_system" ]]; then
  found=false
  for id in "${system_ids[@]}"; do [[ "$id" == "$selected_system" ]] && found=true; done
  [[ "$found" == true ]] || fail "Unknown system: $selected_system (see --list)."
  target_ids=("$selected_system")
fi

verify_images() {
  node - "$ROOT/config.json" "$1" "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [configFile, id, root] = process.argv.slice(2);
const system = JSON.parse(fs.readFileSync(configFile, 'utf8')).systems[id];
for (const format of ['raw', 'vdi']) {
  const file = path.resolve(root, system.images[format]);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty ${format} image for ${id}: ${file}`);
}
NODE
}

if [[ "$force" == true ]]; then
  echo 'WARNING: --force replaces the selected base images, even while VMs are running.' >&2
  echo 'Existing QCOW2/VDI working disks may become incompatible with the rebuilt bases.' >&2
  echo 'The previous RAW/VDI pair will be kept in images/backups/.' >&2
fi
backup_dir=''
for id in "${target_ids[@]}"; do
  script="$ROOT/scripts/prepare/$id.sh"
  [[ -x "$script" ]] || fail "Missing executable preparation script for systems.$id: $script"
  system_start=$SECONDS

  echo
  echo "== $id · 1/2 Sources: sources/$id/ =="
  stage_start=$SECONDS
  "$script" --sources
  sources_elapsed=$((SECONDS - stage_start))
  echo "== $id · sources ready in $(format_duration "$sources_elapsed") =="

  echo "== $id · 2/2 Images: images/$id.raw + images/$id.vdi =="
  stage_start=$SECONDS
  system_backup=''
  if [[ "$force" == true ]]; then
    if [[ -e "$ROOT/images/$id.raw" || -e "$ROOT/images/$id.vdi" ]]; then
      if [[ -z "$backup_dir" ]]; then
        mkdir -p "$ROOT/images/backups"
        backup_dir=$(mktemp -d "$ROOT/images/backups/prepare.XXXXXX")
      fi
      system_backup="$backup_dir/$id"
      mkdir "$system_backup"
      for format in raw vdi; do
        if [[ -e "$ROOT/images/$id.$format" ]]; then
          if ! mv "$ROOT/images/$id.$format" "$system_backup/"; then
            for saved_format in raw vdi; do
              if [[ -e "$system_backup/$id.$saved_format" ]]; then
                mv "$system_backup/$id.$saved_format" "$ROOT/images/"
              fi
            done
            echo "prepare.sh: Could not back up images for $id." >&2
            exit 1
          fi
        fi
      done
      echo "  Previous images saved: $system_backup"
    fi
  elif [[ ! -s "$ROOT/images/$id.raw" && -e "$ROOT/images/$id.vdi" ]]; then
    fail "Cannot build $id.raw while an existing $id.vdi would be reused; use --force to rebuild both."
  fi

  build_force=0
  if [[ "$force" == true ]]; then build_force=1; fi
  if QEMUWEB_PREPARE_FORCE="$build_force" "$script" --images && verify_images "$id"; then
    images_elapsed=$((SECONDS - stage_start))
    echo "== $id · ready in $(format_duration "$((SECONDS - system_start))") (sources $(format_duration "$sources_elapsed"), images $(format_duration "$images_elapsed")) =="
  else
    if [[ "$force" == true ]]; then rm -f "$ROOT/images/$id.raw" "$ROOT/images/$id.vdi"; fi
    if [[ -n "$system_backup" ]]; then
      for format in raw vdi; do
        if [[ -e "$system_backup/$id.$format" ]]; then
          mv "$system_backup/$id.$format" "$ROOT/images/"
        fi
      done
      echo "  Previous images restored from $system_backup" >&2
    fi
    echo "prepare.sh: Image preparation failed for $id after $(format_duration "$((SECONDS - system_start))")." >&2
    exit 1
  fi
done

echo
echo "Prepared ${#target_ids[@]} system(s)."
if [[ -n "$backup_dir" ]]; then echo "Previous images: $backup_dir"; fi
