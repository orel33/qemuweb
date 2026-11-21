#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'HELP'
Usage: bash scripts/prepare.sh [--all | --system <sysname>] [--force] [--proxy <url>]
       bash scripts/prepare.sh --hash [--system <sysname>]
       bash scripts/prepare.sh --list
       bash scripts/prepare.sh --help

Prepare every system by default. For each system:
  1. Fetch and verify sources in sources/<sysname>/.
  2. Build images/<sysname>.raw and images/<sysname>.vdi.
The elapsed time of each step and the system total are displayed.

--list             List systems, allocated image disk usage (GB), date, and the state of the
                   SHA-256 files of the images (ok, old: older than its image, missing).
                   Debian raw images get one more line: "ttyS1 login: yes", "no (rebuild: ...)"
                   or "unknown"; every raw image gets "guest agent: yes (restricted)", "yes (NOT
                   restricted)", "no (rebuild: ...)" or "unknown" (best effort, read-only, needs debugfs).
--all              Prepare every configured system (the default).
--system <sysname> Prepare one configured system.
--force            Rebuild and replace existing images. Save the old pair in
                   images/backups/ for recovery. Running VMs and old working
                   disks may become incompatible with the new base.
--proxy <url>      HTTP proxy (http://host:port) for the downloads and for the build VMs
                   (Debian installer, cloud-init). "none" or an empty value means no
                   proxy. Default: the https_proxy / http_proxy variable, when set.
                   The proxy in use is printed at the start. Debian builds first check
                   that the Debian mirrors answer through it, then show a progress line
                   (phase, estimated percentage, elapsed time) and stop at once, with the
                   end of the serial log, when the installer or cloud-init reports an
                   error. A VM that ends nothing within 30 minutes is stopped.
-6, --ipv6         The build VM reaches the proxy over IPv6 (the proxy name is resolved to its
                   IPv6 address, written in brackets). Without it the VM goes out in IPv4, which
                   a proxy may refuse while it accepts this machine over IPv6.
--follow[=N]       Show the last N lines (20 by default, 1 to 100) of the build VM's serial log
                   under the progress line, redrawn in place on a terminal; without a terminal,
                   the new log lines are printed as they appear.
--hash             Only record the SHA-256 of the existing images in images/<sysname>.raw.sha256
                   and .vdi.sha256 (sha256sum format), without building anything. Every build
                   records them itself; the server uses a hash file that is not older than its
                   image to compare the image with a session archive without reading it.
                   A missing image is reported ("<sysname>.<format>: no image"). Exit status 2 when
                   --system names a system without any image, when no system has an image, or when
                   a hash could not be recorded; a single missing format is only a warning.
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
hash_only=false
proxy_set=false
proxy_value=''
follow_lines=0
ipv6=0
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
    -6|--ipv6) ipv6=1; shift ;;
    --follow) follow_lines=20; shift ;;
    --follow=*)
      follow_lines="${1#--follow=}"
      [[ "$follow_lines" =~ ^[0-9]+$ ]] && (( follow_lines >= 1 && follow_lines <= 100 )) || fail '--follow=N needs a number of lines from 1 to 100.'
      shift ;;
    --hash) hash_only=true; shift ;;
    --proxy)
      [[ "$proxy_set" == false && $# -ge 2 && "$2" != --* ]] || fail 'Expected one proxy URL (or none) after --proxy.'
      proxy_set=true; proxy_value="$2"; shift 2 ;;
    *) fail "Unknown option: $1 (see --help)." ;;
  esac
done

if [[ "$hash_only" == true && ( "$explicit_all" == true || "$force" == true || "$list_only" == true || "$proxy_set" == true || $follow_lines -gt 0 || $ipv6 -eq 1 ) ]]; then
  fail '--hash cannot be combined with --all, --force, --proxy, --ipv6, --follow or --list.'
fi
if [[ "$list_only" == true && ( "$explicit_all" == true || -n "$selected_system" || "$force" == true || "$proxy_set" == true || $follow_lines -gt 0 || $ipv6 -eq 1 ) ]]; then
  fail '--list cannot be combined with preparation options.'
fi

config_ids=$(node - "$ROOT/config.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ids = Object.keys(config.systems || {}).filter(id => id !== 'default');
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
const systems = require(path.join(root, 'common', 'system-config')).readCatalog(configFile).systems;
const heading = ['System', 'RAW GB', 'VDI GB', 'Total GB', 'Built (local time)', 'SHA-256 raw/vdi'];
const rows = [heading];
for (const [id, system] of Object.entries(systems)) {
  if (id === 'default') continue;
  const stats = ['raw', 'vdi'].map(format => {
    try { return fs.statSync(path.resolve(root, system[format === 'raw' ? 'qemu' : 'vbox'].image)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  });
  const gb = stat => stat ? (stat.blocks * 512 / 1e9).toFixed(2) : '-';
  // State of <image>.sha256: ok (not older than its image, as the server requires), old, missing; - without image.
  const hashState = (format, stat) => {
    if (!stat) return '-';
    const file = path.resolve(root, system[format === 'raw' ? 'qemu' : 'vbox'].image) + '.sha256';
    try { return fs.statSync(file).mtimeMs >= stat.mtimeMs ? 'ok' : 'old'; }
    catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  };
  const latest = Math.max(...stats.filter(Boolean).map(stat => stat.mtimeMs), 0);
  const built = latest ? new Date(latest).toLocaleString('sv-SE', {hour12: false}) : '-';
  const total = stats.some(Boolean) ? (stats.reduce((bytes, stat) => bytes + (stat?.blocks || 0) * 512, 0) / 1e9).toFixed(2) : '-';
  rows.push([id, gb(stats[0]), gb(stats[1]), total, built, `${hashState('raw', stats[0])}/${hashState('vdi', stats[1])}`]);
}
const widths = heading.map((_, index) => Math.max(...rows.map(row => row[index].length)));
for (const row of rows) console.log(row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd());
// Best-effort notes per raw image (read-only, never fail the listing): see scripts/prepare/lib/image-probe.js.
try {
  const {ttys1Login, guestAgent, describe, describeGuestAgent} = require(path.join(root, 'scripts', 'prepare', 'lib', 'image-probe'));
  for (const [id, system] of Object.entries(systems)) {
    if (id === 'default' || !system.qemu?.image) continue;
    const image = path.resolve(root, system.qemu.image);
    if (!fs.existsSync(image)) continue;
    if (id.startsWith('debian')) console.log(`${id.padEnd(widths[0])}  ${describe(ttys1Login(image), id)}`);
    console.log(`${id.padEnd(widths[0])}  ${describeGuestAgent(guestAgent(image), id)}`);
  }
} catch { /* the note is optional */ }
NODE
  exit 0
fi

export QEMUWEB_PREPARE_FOLLOW="$follow_lines" QEMUWEB_PREPARE_IPV6="$ipv6"
target_ids=("${system_ids[@]}")
if [[ -n "$selected_system" ]]; then
  found=false
  for id in "${system_ids[@]}"; do [[ "$id" == "$selected_system" ]] && found=true; done
  [[ "$found" == true ]] || fail "Unknown system: $selected_system (see --list)."
  target_ids=("$selected_system")
fi

# Records <image>.sha256 (sha256sum format) for the raw and VDI images of a system, so that the
# server need not read them. A hash file that is not older than its image is kept as it is.
write_image_hashes() {
  local system="$1" format image name
  hash_found=0
  for format in raw vdi; do
    image="$ROOT/images/$system.$format"
    name="$system.$format"
    if [[ ! -s "$image" ]]; then
      if [[ "$hash_only" == true ]]; then echo "  $name: no image"; fi
      continue
    fi
    hash_found=$((hash_found + 1))
    if [[ -e "$image.sha256" && ! "$image.sha256" -ot "$image" ]]; then
      echo "  $name: hash up to date"
    elif (cd "$ROOT/images" && sha256sum "$name" > "$name.sha256.tmp" && mv -f "$name.sha256.tmp" "$name.sha256"); then
      echo "  $name: hash recorded"
    else
      rm -f "$image.sha256.tmp"
      echo "prepare.sh: Could not record the hash of $name; the server will compute it." >&2
      hash_failed=$((hash_failed + 1))
    fi
  done
}

if [[ "$hash_only" == true ]]; then
  hash_failed=0
  hash_total=0
  for id in "${target_ids[@]}"; do
    if [[ -z "$selected_system" && ! -s "$ROOT/images/$id.raw" && ! -s "$ROOT/images/$id.vdi" ]]; then
      echo "  $id: not built, skipped"
      continue
    fi
    write_image_hashes "$id"
    hash_total=$((hash_total + hash_found))
    if [[ -n "$selected_system" && $hash_found -eq 1 ]]; then
      for format in raw vdi; do
        [[ -s "$ROOT/images/$id.$format" ]] || echo "prepare.sh: $id.$format is missing: nothing to hash for it (run: bash scripts/prepare.sh --system $id --force to build both)." >&2
      done
    fi
  done
  if (( hash_total == 0 )); then
    if [[ -n "$selected_system" ]]; then
      fail "Nothing to hash for $selected_system: no image built (run: bash scripts/prepare.sh --system $selected_system)."
    fi
    fail 'Nothing to hash: no image built (run: bash scripts/prepare.sh).'
  fi
  if (( hash_failed > 0 )); then exit 2; fi
  exit 0
fi

# Shared preparation code. Choose the proxy once (exit status 2 when it is invalid);
# the per-system scripts inherit it through the environment.
source "$ROOT/scripts/prepare/lib/common.sh"
if [[ "$proxy_set" == true ]]; then proxy_init "$proxy_value"; else proxy_init; fi
echo "Proxy: $(proxy_describe)"

verify_images() {
  node - "$ROOT/config.json" "$1" "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [configFile, id, root] = process.argv.slice(2);
const system = require(path.join(root, 'common', 'system-config')).readCatalog(configFile).systems[id];
for (const format of ['raw', 'vdi']) {
  const file = path.resolve(root, system[format === 'raw' ? 'qemu' : 'vbox'].image);
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
      for format in raw vdi; do
        if [[ -e "$ROOT/images/$id.$format.sha256" ]]; then mv -f "$ROOT/images/$id.$format.sha256" "$system_backup/"; fi
      done
      echo "  Previous images saved: $system_backup"
    fi
  elif [[ ! -s "$ROOT/images/$id.raw" && -e "$ROOT/images/$id.vdi" ]]; then
    fail "Cannot build $id.raw while an existing $id.vdi would be reused; use --force to rebuild both."
  fi

  build_force=0
  if [[ "$force" == true ]]; then build_force=1; fi
  if QEMUWEB_PREPARE_FORCE="$build_force" "$script" --images && verify_images "$id"; then
    write_image_hashes "$id"
    images_elapsed=$((SECONDS - stage_start))
    echo "== $id · ready in $(format_duration "$((SECONDS - system_start))") (sources $(format_duration "$sources_elapsed"), images $(format_duration "$images_elapsed")) =="
  else
    if [[ "$force" == true ]]; then rm -f "$ROOT/images/$id.raw" "$ROOT/images/$id.vdi" "$ROOT/images/$id.raw.sha256" "$ROOT/images/$id.vdi.sha256"; fi
    if [[ -n "$system_backup" ]]; then
      for format in raw vdi; do
        if [[ -e "$system_backup/$id.$format" ]]; then
          mv "$system_backup/$id.$format" "$ROOT/images/"
        fi
        if [[ -e "$system_backup/$id.$format.sha256" ]]; then
          mv "$system_backup/$id.$format.sha256" "$ROOT/images/"
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
