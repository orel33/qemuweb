#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'HELP'
Usage: bash scripts/prepare.sh                      (same as --list: nothing is built)
       bash scripts/prepare.sh --list
       bash scripts/prepare.sh --system <id|all> [--force] [--proxy <url>] [-6] [--parallel[=N]]
       bash scripts/prepare.sh --all [--force] [--proxy <url>] [-6] [--parallel[=N]]   (same as --system all)
       bash scripts/prepare.sh --hash [--system <id|all>]
       bash scripts/prepare.sh --help

Without argument, only list the systems. To build, name them with --system. For each system:
  1. Fetch and verify sources in sources/<sysname>/.
  2. Build images/<sysname>.raw and images/<sysname>.vdi.
The elapsed time of each step and the system total are displayed.

--list             List systems, allocated image disk usage (GB), date, and the state of the
                   SHA-256 files of the images (ok, old: older than its image, missing).
                   Debian raw images get one more line: "ttyS1 login: yes", "no"
                   or "unknown"; every raw image gets "guest agent: yes (restricted)", "yes (NOT
                   restricted)", "no" or "unknown" (best effort, read-only, needs debugfs).
--system <id|all>  Prepare one configured system, or every one with "all" ("all" is reserved:
                   no system can have this ID). Required by --force, --proxy, -6 and --parallel.
--all              Same as --system all.
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
--parallel[=N]     Build several systems at the same time (useful with --system all): at most N at
                   once (1 to 8), or without N as many as there are systems, at most 4. --parallel=1
                   is the sequential build. Each build writes its whole output to its own log,
                   sources/.prepare/.parallel.XXXXXX/<id>.log (the paths are printed at the start
                   of each build: follow one with tail -f), and one status line per system is
                   shown (redrawn in place on a terminal). A failed system does not stop the others; the summary lists every
                   system and the end of each failed log, the exit status is non-zero. Ctrl+C
                   stops every build and its VM. Warns when the machine has less than 2 GB of free
                   memory per build, fewer cores than builds or less than 10 GB of free disk.
                   Without --system all it has no effect (one system).
--hash             Only record the SHA-256 of the existing images in images/<sysname>.raw.sha256
                   and .vdi.sha256 (sha256sum format), without building anything. Every build
                   records them itself; the server uses a hash file that is not older than its
                   image to compare the image with a session archive without reading it.
                   A missing image is reported ("<sysname>.<format>: no image"). Without --system
                   (or with --system all), every system with an image is hashed. Exit status 2 when
                   --system names a system without any image, when no system has an image, or when
                   a hash could not be recorded; a single missing format is only a warning.
HELP
}

fail() { echo "prepare.sh: $*" >&2; exit 2; }

format_duration() {
  local seconds="$1"
  printf '%02d:%02d:%02d' "$((seconds / 3600))" "$(((seconds / 60) % 60))" "$((seconds % 60))"
}

argument_count=$#
selected_system=''
system_given=false
list_only=false
force=false
hash_only=false
proxy_set=false
proxy_value=''
ipv6=0
parallel_set=false
parallel_max=0   # --parallel=N; 0: as many as there are systems, at most 4
while (( $# )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --list) list_only=true; shift ;;
    --all)
      [[ "$system_given" == false ]] || fail 'Choose only one of --system <id|all> and --all.'
      system_given=true; selected_system=all; shift ;;
    --system)
      [[ "$system_given" == false ]] || fail 'Choose only one of --system <id|all> and --all.'
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail 'Expected a system ID, or all, after --system.'
      system_given=true; selected_system="$2"; shift 2 ;;
    --force) force=true; shift ;;
    -6|--ipv6) ipv6=1; shift ;;
    --follow|--follow=*) fail '--follow was removed: follow the build with tail -f on the log file printed at the start of the build.' ;;
    --parallel) parallel_set=true; parallel_max=0; shift ;;
    --parallel=*)
      parallel_max="${1#--parallel=}"
      [[ "$parallel_max" =~ ^[0-9]+$ ]] && (( parallel_max >= 1 && parallel_max <= 8 )) || fail '--parallel=N needs a number of builds from 1 to 8.'
      parallel_set=true; shift ;;
    --hash) hash_only=true; shift ;;
    --proxy)
      [[ "$proxy_set" == false && $# -ge 2 && "$2" != --* ]] || fail 'Expected one proxy URL (or none) after --proxy.'
      proxy_set=true; proxy_value="$2"; shift 2 ;;
    *) fail "Unknown option: $1 (see --help)." ;;
  esac
done

# No argument: list, never build.
if (( argument_count == 0 )) && [[ "$system_given" == false ]]; then list_only=true; fi
# The options that only make sense for a build.
build_options=()
[[ "$force" == true ]] && build_options+=(--force)
[[ "$proxy_set" == true ]] && build_options+=(--proxy)
(( ipv6 == 1 )) && build_options+=(--ipv6)
[[ "$parallel_set" == true ]] && build_options+=(--parallel)
if [[ "$hash_only" == true && ( "$list_only" == true || ${#build_options[@]} -gt 0 ) ]]; then
  fail '--hash cannot be combined with --list, --force, --proxy, --ipv6 or --parallel.'
fi
if [[ "$list_only" == true && ( "$system_given" == true || ${#build_options[@]} -gt 0 ) ]]; then
  fail '--list cannot be combined with preparation options.'
fi
if [[ "$hash_only" == false && "$list_only" == false && "$system_given" == false ]]; then
  fail "${build_options[*]} needs a system: choose --system <id|all>."
fi
# "all" is every system (reserved word); an empty selection below means the same for --hash.
if [[ "$selected_system" == all ]]; then selected_system=''; fi

config_ids=$(node - "$ROOT/config.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ids = Object.keys(config.systems || {}).filter(id => id !== 'default');
if (!ids.length) throw new Error('No systems declared in config.json.');
for (const id of ids) {
  if (id === 'all') throw new Error('"all" is reserved (--system all): no system can have this ID.');
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
  const {ttys1Login, quietConsole, guestAgent, describe, describeQuietConsole, describeGuestAgent} = require(path.join(root, 'scripts', 'prepare', 'lib', 'image-probe'));
  for (const [id, system] of Object.entries(systems)) {
    if (id === 'default' || !system.qemu?.image) continue;
    const image = path.resolve(root, system.qemu.image);
    if (!fs.existsSync(image)) continue;
    if (id.startsWith('debian')) {
      console.log(`${id.padEnd(widths[0])}  ${describe(ttys1Login(image))}`);
      console.log(`${id.padEnd(widths[0])}  ${describeQuietConsole(quietConsole(image))}`);
    }
    console.log(`${id.padEnd(widths[0])}  ${describeGuestAgent(guestAgent(image))}`);
  }
} catch { /* the note is optional */ }
console.log('To build: bash scripts/prepare.sh --system <id|all> [--force]');
NODE
  exit 0
fi

export QEMUWEB_PREPARE_IPV6="$ipv6"
target_ids=("${system_ids[@]}")
if [[ -n "$selected_system" ]]; then
  found=false
  for id in "${system_ids[@]}"; do [[ "$id" == "$selected_system" ]] && found=true; done
  [[ "$found" == true ]] || fail "Unknown system: $selected_system (see --list)."
  target_ids=("$selected_system")
fi
# --parallel: how many builds at once. One system (or --parallel=1) is the sequential build, unchanged.
jobs_to_run=1
if [[ "$parallel_set" == true && ${#target_ids[@]} -gt 1 ]]; then
  jobs_to_run=$parallel_max
  if (( jobs_to_run == 0 )); then jobs_to_run=4; fi
  if (( jobs_to_run > ${#target_ids[@]} )); then jobs_to_run=${#target_ids[@]}; fi
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
    fail 'Nothing to hash: no image built (run: bash scripts/prepare.sh --system <id|all>).'
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
# ---------------------------------------------------------------------------
# One system: sources, then images (with the backup of the existing images under --force and the
# recording of the hashes). The sequential mode calls it in this shell, one system after the other;
# the parallel mode (--parallel) calls it in a background subshell per system, with its output in a log.
# Everything it touches is private to the system <id> (sources/<id>/, images/<id>.*, a mktemp
# directory named after the id in sources/.prepare/, QEMU user-mode networks without any fixed
# port), except images/backups/, whose per-run directory is created by the parent before the jobs
# start (backup_dir) and holds one subdirectory per system.
# ---------------------------------------------------------------------------
backup_dir=''
job_mode=0      # 1 in a parallel job
images_phase=0  # 1 from the backup of the images to the end of the build

# Put the previous images (saved by --force) back and drop the partial ones. Uses $id and $system_backup.
restore_backup() {
  local format
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
}

# A parallel job stopped by SIGTERM (Ctrl+C of the parent): the per-system script has already cleaned
# its build VM through its own EXIT trap; give the previous images back.
abort_job() {
  if (( images_phase )); then restore_backup; fi
  exit 143
}

build_system() {
  id="$1"
  script="$ROOT/scripts/prepare/$id.sh"
  [[ -x "$script" ]] || fail "Missing executable preparation script for systems.$id: $script"
  system_start=$SECONDS
  system_backup=''
  if (( job_mode )); then trap abort_job TERM; fi

  echo
  echo "== $id · 1/2 Sources: sources/$id/ =="
  stage_start=$SECONDS
  "$script" --sources
  sources_elapsed=$((SECONDS - stage_start))
  echo "== $id · sources ready in $(format_duration "$sources_elapsed") =="

  echo "== $id · 2/2 Images: images/$id.raw + images/$id.vdi =="
  stage_start=$SECONDS
  images_phase=1
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
    images_phase=0
    echo "== $id · ready in $(format_duration "$((SECONDS - system_start))") (sources $(format_duration "$sources_elapsed"), images $(format_duration "$images_elapsed")) =="
  else
    restore_backup
    images_phase=0
    echo "prepare.sh: Image preparation failed for $id after $(format_duration "$((SECONDS - system_start))")." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# --parallel: build several systems at the same time.
#
# Each system is a background job running build_system in its own process group (job control is
# switched on only while the job is forked, so Ctrl+C reaches this script alone, which stops every
# group itself). A job writes its whole output to <run_dir>/<id>.log; this script shows one status
# line per system (redrawn in place on a terminal, plain "id: started / done / FAILED" lines
# otherwise), starts the next queued system as soon as a job ends (at most $jobs_to_run at once),
# and ends with a summary: the last 20 lines of the log of each failed system. A failing job does
# not stop the others. SIGINT/SIGTERM: SIGTERM to every running group (the per-system EXIT traps
# stop their build VM and give the previous images back), SIGKILL after 20 s.
# The systems share no mutable state (see above); two systems never download the same source file.
# ---------------------------------------------------------------------------
job_state=()   # queued | running | done | FAILED | stopped
job_pid=() job_start=() job_time=() job_code=() job_log=()
job_serial=()   # the serial log of the build VM, read back from the job log
status_rows=0

# Progress of a job, from its own log: the last progress line of the build VM, or the last "== id · ..." line.
job_progress() {
  local line
  line=$(tail -n 60 "$1" 2>/dev/null | LC_ALL=C grep -aE '^(\[[#-]{10}\] |== )' | tail -n 1 || true)
  line=$(sed -E 's/^== [^ ]+ [^ ]+ //; s/ ==$//; s/  [0-9]+:[0-9]{2}  log [0-9]+ KB$//' <<< "$line")
  printf '%s' "$line"
}

# The "log:" line of build_log_info (scripts/prepare/lib/common.sh) in the job log.
job_paths() {
  local i="$1"
  job_serial[i]=$(sed -nE 's/^    log: +(.*)  \(follow: .*$/\1/p' "${job_log[$i]}" 2>/dev/null | head -n 1 || true)
}

status_line() {
  local i="$1" elapsed='' detail=''
  case "${job_state[$i]}" in
    running) elapsed=$(format_duration "$((SECONDS - job_start[i]))"); detail=$(job_progress "${job_log[$i]}") ;;
    done|FAILED) elapsed=$(format_duration "${job_time[$i]}") ;;
  esac
  printf '  %-*s  %-7s  %8s  %s' "$id_width" "${target_ids[$i]}" "${job_state[$i]}" "$elapsed" "$detail"
}

draw_status() {
  local width=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)} i line
  if (( status_rows > 0 )); then printf '\033[%dA' "$status_rows"; fi
  for i in "${!target_ids[@]}"; do
    line=$(status_line "$i")
    printf '\r\033[K%s\n' "${line:0:$((width - 1))}"
  done
  status_rows=${#target_ids[@]}
}

# SIGTERM to the process group of every running job, wait for them (SIGKILL after 20 s), then sweep
# what is left in the groups (a build VM whose script died).
stop_jobs() {
  local i pids=() watchdog=''
  for i in "${!job_state[@]}"; do
    if [[ "${job_state[$i]}" == running ]]; then pids+=("${job_pid[$i]}"); fi
  done
  (( ${#pids[@]} > 0 )) || return 0
  for i in "${pids[@]}"; do kill -TERM -- "-$i" 2>/dev/null || true; done
  ( sleep 20; for i in "${pids[@]}"; do kill -KILL -- "-$i" 2>/dev/null || true; done ) >/dev/null 2>&1 &
  watchdog=$!
  wait "${pids[@]}" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
  for i in "${pids[@]}"; do kill -KILL -- "-$i" 2>/dev/null || true; done
  for i in "${!job_state[@]}"; do
    if [[ "${job_state[$i]}" == running ]]; then job_state[i]=stopped; fi
  done
}

parallel_abort() {
  trap '' INT TERM
  echo >&2
  echo "prepare.sh: interrupted (SIGTERM), stopping the build(s) and their VMs..." >&2
  stop_jobs
  echo "prepare.sh: builds stopped. Logs kept in $run_dir" >&2
  exit "$1"
}

start_job() {
  local i="$1"
  set -m
  ( build_system "${target_ids[$i]}" ) >"${job_log[$i]}" 2>&1 </dev/null &
  job_pid[i]=$!
  set +m
  job_state[i]=running
  job_start[i]=$SECONDS
}

run_parallel() {
  local max="$1" total=${#target_ids[@]} next=0 running=0 finished=0 i tty=0
  if [[ -t 1 ]]; then tty=1; fi
  for i in "${!target_ids[@]}"; do
    job_state[i]=queued
    job_log[i]="$run_dir/${target_ids[$i]}.log"
    job_serial[i]=''
  done
  trap 'parallel_abort 130' INT
  trap 'parallel_abort 143' TERM
  trap stop_jobs EXIT
  while (( finished < total )); do
    for i in "${!target_ids[@]}"; do
      if [[ "${job_state[$i]}" == running ]] && ! kill -0 "${job_pid[$i]}" 2>/dev/null; then
        job_code[i]=0
        wait "${job_pid[$i]}" || job_code[i]=$?
        job_time[i]=$((SECONDS - job_start[i]))
        job_paths "$i"
        if (( job_code[i] == 0 )); then
          job_state[i]=done
          if (( ! tty )); then echo "${target_ids[$i]}: done in $(format_duration "${job_time[$i]}")"; fi
        else
          job_state[i]=FAILED
          if (( ! tty )); then echo "${target_ids[$i]}: FAILED after $(format_duration "${job_time[$i]}") (log ${job_log[$i]})"; fi
        fi
        running=$((running - 1)); finished=$((finished + 1))
      fi
    done
    # Without a terminal, say where to follow a build as soon as its VM has started.
    if (( ! tty )); then
      for i in "${!target_ids[@]}"; do
        if [[ "${job_state[$i]}" == running && -z "${job_serial[$i]}" ]]; then
          job_paths "$i"
          if [[ -n "${job_serial[$i]}" ]]; then echo "${target_ids[$i]}: build VM started, serial log ${job_serial[$i]}"; fi
        fi
      done
    fi
    while (( running < max && next < total )); do
      start_job "$next"
      if (( ! tty )); then echo "${target_ids[$next]}: started, log ${job_log[$next]}"; fi
      running=$((running + 1)); next=$((next + 1))
    done
    if (( tty )); then draw_status; fi
    if (( finished < total )); then sleep 1; fi
  done
  trap - INT TERM EXIT
}

if (( jobs_to_run > 1 )); then
  job_mode=1
  for id in "${target_ids[@]}"; do
    [[ -x "$ROOT/scripts/prepare/$id.sh" ]] || fail "Missing executable preparation script for systems.$id: $ROOT/scripts/prepare/$id.sh"
  done
  run_dir=$(mktemp -d "$RUNTIME/.parallel.XXXXXX")
  id_width=0
  for id in "${target_ids[@]}"; do if (( ${#id} > id_width )); then id_width=${#id}; fi; done
  # The previous images are saved under one directory for the whole run, created here: the jobs only add their own subdirectory.
  if [[ "$force" == true ]]; then
    for id in "${target_ids[@]}"; do
      if [[ -z "$backup_dir" && ( -e "$ROOT/images/$id.raw" || -e "$ROOT/images/$id.vdi" ) ]]; then
        mkdir -p "$ROOT/images/backups"
        backup_dir=$(mktemp -d "$ROOT/images/backups/prepare.XXXXXX")
      fi
    done
  fi
  echo "Parallel build: ${#target_ids[@]} systems, up to $jobs_to_run at once (${target_ids[*]}). Logs: $run_dir/<id>.log"
  # Building several Debian VMs at once is heavy: warn, never refuse.
  mem_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || true)
  if [[ "$mem_kb" =~ ^[0-9]+$ ]] && (( mem_kb < jobs_to_run * 2 * 1024 * 1024 )); then
    echo "WARNING: $((mem_kb / 1024)) MB of memory available for $jobs_to_run builds at once (2 GB each are advised): lower --parallel=N if the machine swaps." >&2
  fi
  cpu_count=$(nproc 2>/dev/null || echo 0)
  if (( cpu_count > 0 && cpu_count < jobs_to_run )); then
    echo "WARNING: $cpu_count CPU core(s) for $jobs_to_run builds at once: the builds will be slower; lower --parallel=N." >&2
  fi
  for dir in images sources; do
    free_kb=$(df -Pk "$ROOT/$dir" 2>/dev/null | awk 'NR == 2 {print $4}' || true)
    if [[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb < 10 * 1024 * 1024 )); then
      echo "WARNING: only $((free_kb / 1024 / 1024)) GB free where $dir/ is (10 GB advised for the builds)." >&2
    fi
  done
  run_parallel "$jobs_to_run"

  echo
  worst=0; failed_count=0
  for i in "${!target_ids[@]}"; do
    printf '  %-*s  %-6s  %s  log %s\n' "$id_width" "${target_ids[$i]}" "${job_state[$i]}" "$(format_duration "${job_time[$i]}")" "${job_log[$i]}"
    # The build VM directory is removed after a success: only existing files are shown.
    if [[ -n "${job_serial[$i]}" && -e "${job_serial[$i]}" ]]; then printf '  %*s  serial log %s  (tail -f)\n' "$id_width" '' "${job_serial[$i]}"; fi
    if [[ "${job_state[$i]}" == FAILED ]]; then
      failed_count=$((failed_count + 1))
      if (( job_code[i] > worst )); then worst=${job_code[$i]}; fi
    fi
  done
  if (( failed_count > 0 )); then
    for i in "${!target_ids[@]}"; do
      [[ "${job_state[$i]}" == FAILED ]] || continue
      {
        echo
        echo "prepare.sh: ${target_ids[$i]} failed (exit status ${job_code[$i]}). Last 20 lines of its log:"
        tail -n 20 "${job_log[$i]}" | sed 's/^/  | /'
        echo "  Full log: ${job_log[$i]}"
      } >&2
    done
    echo >&2
    echo "prepare.sh: $failed_count of ${#target_ids[@]} system(s) failed. Logs kept in $run_dir" >&2
    if [[ -n "$backup_dir" ]]; then echo "Previous images: $backup_dir" >&2; fi
    exit "$worst"
  fi
  rm -rf "$run_dir"
else
  for id in "${target_ids[@]}"; do build_system "$id"; done
fi

echo
echo "Prepared ${#target_ids[@]} system(s)."
if [[ -n "$backup_dir" ]]; then echo "Previous images: $backup_dir"; fi
