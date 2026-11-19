#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Keep generated images, downloaded source files, and temporary build state
# separate so preparation scripts can be rerun safely.
IMAGES="$ROOT/images"
SOURCES="$ROOT/sources"
RUNTIME="$ROOT/runtime"
mkdir -p "$IMAGES" "$SOURCES" "$RUNTIME"

parse_prepare_mode() {
  if (( $# > 1 )); then
    echo 'Usage: scripts/prepare/<system>.sh [--sources | --images]' >&2
    exit 2
  fi
  case "${1:---all}" in
    --all) PREPARE_MODE=all ;;
    --sources) PREPARE_MODE=sources ;;
    --images) PREPARE_MODE=images ;;
    *) echo "Unknown preparation mode: $1" >&2; exit 2 ;;
  esac
  # Every per-system script calls this first: take over the proxy chosen by
  # prepare.sh (or the environment when the script runs on its own).
  proxy_inherit
}

prepare_sources() { [[ "$PREPARE_MODE" != images ]]; }
prepare_images() { [[ "$PREPARE_MODE" != sources ]]; }

require_commands() {
  # Check tools only when a script actually needs to build an image.
  for command in "$@"; do
    command -v "$command" >/dev/null || { echo "Required preparation tool not found: $command" >&2; exit 1; }
  done
}

fetch_file() {
  local url="$1" target="$2"
  # Reuse an existing non-empty download; this makes interrupted runs cheap to resume.
  if [[ -s "$target" ]]; then
    echo "  Reuse source: $target"
  else
    echo "  Download: $url -> $target"
    # Download to a side file so that an interrupted run never leaves a truncated
    # file that the check above would reuse. curl reads the proxy from http_proxy
    # and https_proxy, which proxy_init sets (or clears) for every build.
    if ! curl -fL --retry 3 --connect-timeout 30 "$url" -o "$target.part"; then
      rm -f "$target.part"
      {
        echo "prepare.sh: download failed: $url"
        echo "  Proxy in use: $(proxy_describe)."
        echo '  Without direct Internet access, set the proxy with --proxy URL or the https_proxy variable.'
      } >&2
      return 1
    fi
    mv -f "$target.part" "$target"
  fi
}

move_if_present() {
  local source="$1" destination="$2"
  # Migrate older top-level source/image files into the per-system layout once.
  [[ -e "$destination" || ! -e "$source" ]] && return 0
  mkdir -p "$(dirname "$destination")"
  mv -- "$source" "$destination"
}

make_vdi() {
  local raw="$1" vdi="$2"
  # Keep RAW as the canonical image and derive VDI only when it is missing.
  [[ -s "$vdi" ]] && return 0
  qemu-img convert -p -f raw -O vdi "$raw" "$vdi.tmp"
  chmod 444 "$vdi.tmp"
  mv "$vdi.tmp" "$vdi"
}

prep_acceleration() {
  # Avoid nested KVM when VirtualBox is already running; otherwise use KVM when
  # available and fall back to QEMU's software emulation.
  if command -v VBoxManage >/dev/null 2>&1 && [[ -n "$(VBoxManage list runningvms 2>/dev/null || true)" ]]; then
    printf 'tcg'
  elif [[ -r /dev/kvm && -w /dev/kvm ]]; then
    printf 'kvm'
  else
    printf 'tcg'
  fi
}

# ---------------------------------------------------------------------------
# HTTP proxy
#
# The proxy matters twice: curl downloads on this machine, and the VM that
# builds the image (Debian installer, cloud-init) which cannot see this
# machine's environment and has to be told. PROXY_URL is empty when no proxy is
# used. Only http:// and https:// proxies are supported.
# ---------------------------------------------------------------------------
PROXY_URL=''
PROXY_SOURCE=''

proxy_valid() {
  local re='^https?://(([^/@:]+(:[^/@]*)?)@)?[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'
  [[ "$1" =~ $re ]]
}

# Hide the credentials of a URL (user:password@) before it is displayed.
proxy_redact() {
  local re='^(https?://)[^/@]*@(.*)$'
  if [[ "$1" =~ $re ]]; then printf '%s***@%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; else printf '%s' "$1"; fi
}

proxy_describe() {
  if [[ -z "$PROXY_URL" ]]; then printf 'none'; else printf '%s (%s)' "$(proxy_redact "$PROXY_URL")" "$PROXY_SOURCE"; fi
}

# proxy_init [VALUE]: with an argument (the --proxy option; empty or "none" means
# no proxy) use it, otherwise the https_proxy/http_proxy variable that curl also
# reads. Validate it (exit 2 when bad), then make the environment match: curl
# sees exactly this proxy, or none.
proxy_init() {
  local value='' source='' name='' label
  if (( $# )); then
    value="$1"; source='--proxy'; label='--proxy'
  else
    for name in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY; do
      if [[ -n "${!name:-}" ]]; then value="${!name}"; source='from the environment'; label="the $name variable"; break; fi
    done
  fi
  if [[ "$value" == none ]]; then value=''; fi
  if [[ -n "$value" ]] && ! proxy_valid "$value"; then
    echo "prepare.sh: invalid proxy in $label: $(proxy_redact "$value")" >&2
    echo "  Expected http://host:port or https://host:port (or 'none' for no proxy)." >&2
    exit 2
  fi
  PROXY_URL="$value"
  if [[ -z "$value" ]]; then PROXY_SOURCE=''; else PROXY_SOURCE="$source"; fi
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
  if [[ -n "$PROXY_URL" ]]; then export http_proxy="$PROXY_URL" https_proxy="$PROXY_URL"; fi
  export QEMUWEB_PREPARE_PROXY="$PROXY_URL" QEMUWEB_PREPARE_PROXY_SOURCE="$PROXY_SOURCE"
}

# Per-system scripts take over what prepare.sh chose.
proxy_inherit() {
  if [[ -n "${QEMUWEB_PREPARE_PROXY_SOURCE+x}" ]]; then
    PROXY_URL="${QEMUWEB_PREPARE_PROXY:-}"
    PROXY_SOURCE="$QEMUWEB_PREPARE_PROXY_SOURCE"
  else
    proxy_init
  fi
}

# The proxy as the build VM must use it. In QEMU user-mode networking the host
# is 10.0.2.2, so a proxy on this machine's loopback is reached there.
guest_proxy_url() {
  local re='^(https?://([^@/]*@)?)(localhost|127\.[0-9.]+)([:/].*)?$'
  if [[ "$PROXY_URL" =~ $re ]]; then printf '%s10.0.2.2%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[4]}"; else printf '%s' "$PROXY_URL"; fi
}

# ---------------------------------------------------------------------------
# Early network check, before a VM starts
# ---------------------------------------------------------------------------
# The mirrors the Debian installer and cloud-init use (http, as the preseed and
# the cloud image do) and the suite the images are built for.
DEBIAN_SUITE=trixie
DEBIAN_MIRROR_URL=http://deb.debian.org/debian
DEBIAN_SECURITY_URL=http://security.debian.org/debian-security

# Fetch the Release files of the mirrors from this machine, with the same proxy
# as the VM will use. Stop at once with a clear message when one is unreachable.
check_debian_mirrors() {
  local id="$1" url err
  local args=(-fsSL --connect-timeout 10 --max-time 30 -o /dev/null)
  if [[ -n "$PROXY_URL" ]]; then args+=(--proxy "$PROXY_URL"); else args+=(--noproxy '*'); fi
  echo "  Checking the Debian mirrors (proxy: $(proxy_describe))"
  for url in "$DEBIAN_MIRROR_URL/dists/$DEBIAN_SUITE/Release" "$DEBIAN_SECURITY_URL/dists/$DEBIAN_SUITE-security/Release"; do
    if ! err=$(curl "${args[@]}" "$url" 2>&1); then
      {
        echo "prepare.sh: the Debian mirror is not reachable from this machine, so $id cannot be built:"
        echo "  $url"
        echo "  ${err:-curl failed}"
        echo "  Proxy in use: $(proxy_describe)."
        echo '  The build VM downloads Debian packages through the same network. Set the proxy with'
        echo '  --proxy URL (for example --proxy http://proxy:3128/) or the https_proxy variable, or build'
        echo "  the image on a machine with Internet access and copy images/$id.raw and images/$id.vdi"
        echo '  here (then run: bash scripts/prepare.sh --hash).'
      } >&2
      exit 1
    fi
  done
}

# ---------------------------------------------------------------------------
# Watching a build VM through its serial log
# ---------------------------------------------------------------------------
# A VM that builds an image writes its console to a serial log. watch_vm reads it
# to (1) stop at once when the log shows a failure that will never recover (the
# Debian installer, for example, shows an error dialog and waits for a human),
# (2) draw a progress line, and (3) end the build on a success marker.

# Limits, in seconds. The total limit ends any build; a VM silent for
# PREPARE_STALL_WARN seconds is reported, and one silent for the stall limit of
# the build (when it has one) is stopped.
PREPARE_VM_TIMEOUT=1800
PREPARE_STALL_WARN=300

# Failure strings, one place for all builds. Each is an extended regular
# expression matched case-insensitively against the log WITHOUT escape sequences
# and WITHOUT any whitespace (a screen drawn by the installer may be cut by cursor
# movements), so spaces in a string here are only for reading.
# They come from the debconf templates of the Debian installer (choose-mirror,
# main-menu, preseed, netcfg, base-installer) and from cloud-init, not from a
# recorded log: check them against a real failing log when one is available.
DEBIAN_INSTALLER_FAILURES=(
  'Bad archive mirror'                 # the error dialog of an unreachable mirror
  'Installation step failed'           # main-menu: a step failed, waits for a choice
  'Failed to retrieve'
  'Unable to .*mirror'
  'Unable to install'                  # for example "Unable to install the selected kernel"
  'Failed to run preseeded command'    # the late command failed
  'Execution of preseeded command'
  'Debootstrap error'
  'Network autoconfiguration failed'   # no DHCP answer
  'No Ethernet card detected'
)
CLOUD_INIT_FAILURES=(
  'QEMUNET_IMAGE_SETUP_FAILED'         # the final runcmd of debian-common.sh
  'Failed to install packages'
  'Package install failed'
  'Failed to run module'
  'Failed run of stage'
  'Unable to locate package'
  'Failed to start .*Cloud'
)

# Progress phases: "percent@label@regex", regex on the same normalised log. The
# phase shown is the one with the highest percentage whose marker is in the log,
# so it never goes back. THE PERCENTAGES ARE AN ESTIMATE BY PHASE (the position
# of the phase in a typical build), not a measure of work done; a phase whose
# marker never matches just keeps the previous label. The markers are the titles
# of the Debian installer's steps and the cloud-init stage banners; they are
# unverified against a real log, which is why the line also shows the size of
# the log, so that a build can be seen alive even when no marker matches.
# The gauge stays under 100% until the end marker is seen.
DEBIAN_INSTALLER_PHASES=(
  '3@Booting the installer@Linuxversion'
  '8@Detecting the network hardware@Detect(ing)?networkhardware'
  '12@Configuring the network@Configur(e|ing)thenetwork|DHCP'
  '18@Choosing the mirror@Choose(a)?mirror|ReleaseFile'
  '22@Downloading the installer components@Downloadinstallercomponents|Downloadinginstallercomponents'
  '28@Detecting the disks@Detect(ing)?disks'
  '33@Partitioning the disk@Partition(ing|disks)|Creating.*filesystem'
  '40@Installing the base system@Install(ing)?thebasesystem|debootstrap'
  '50@Unpacking the base system@basesystem.*Unpacking'
  '60@Configuring the base system@basesystem.*Configuring'
  '65@Configuring the package manager@Configurethepackagemanager|apt-setup'
  '70@Selecting and installing software@Selectandinstallsoftware|tasksel'
  '78@Downloading and unpacking software@Selectandinstallsoftware.*(Unpacking|Retrieving)'
  '88@Setting up software@Selectandinstallsoftware.*Configuring'
  '92@Installing the GRUB boot loader@Install(ing)?(the)?GRUB|grub-install'
  '96@Finishing the installation@Finish(ing)?theinstallation'
  '98@Image prepared, waiting for the VM to stop@QEMUNET_IMAGE_PREPARED'
)
CLOUD_INIT_PHASES=(
  '3@Booting the cloud image@Linuxversion'
  '15@Cloud-init: local stage@Cloud-initv.*init-local'
  '25@Cloud-init: network up@running.init.at|ci-info'
  '35@Cloud-init: configuring (apt)@modules:config'
  '45@Cloud-init: updating and installing packages (nothing is printed here)@modules:final'
  '92@Image prepared, waiting for cloud-init to finish@QEMUNET_IMAGE_PREPARED'
)
# End markers (regex on the normalised log). Debian installer: the late command
# prints it, then the VM must power off. Cloud-init: both its last line and ours.
DEBIAN_INSTALLER_DONE='QEMUNET_IMAGE_PREPARED'
CLOUD_INIT_DONE='QEMUNET_IMAGE_PREPARED.*Cloud-initv.*finishedat|Cloud-initv.*finishedat.*QEMUNET_IMAGE_PREPARED'

# Serial output without terminal escape sequences and control characters.
serial_strip() {
  local esc=$'\033'
  LC_ALL=C sed -E "s/${esc}\\[[0-9;?]*[@-~]//g; s/${esc}[()#][A-Za-z0-9]//g; s/${esc}[=>78MDEc]//g" | LC_ALL=C tr -d '\000-\010\013-\037\177'
}

# serial_has FILE REGEX: is REGEX (case-insensitive) in the normalised log FILE?
serial_has() { LC_ALL=C grep -aqiE -- "$2" "$1"; }

# Stop a VM (SIGTERM, then SIGKILL after 5 s) and reap it.
vm_stop() {
  local pid="$1" i
  kill -TERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

PREPARE_LINE_OPEN=0   # 1 while a progress line, not yet ended by a newline, is on the terminal
progress_end_line() {
  if (( PREPARE_LINE_OPEN )); then echo; PREPARE_LINE_OPEN=0; fi
}

progress_gauge() {
  local filled=$(( $1 / 10 )) i out=''
  for (( i = 0; i < 10; i++ )); do
    if (( i < filled )); then out+='#'; else out+='-'; fi
  done
  printf '[%s]' "$out"
}

# vm_failed LABEL PID LOG REASON: stop the VM and explain the failure. The caller
# exits with status 1 (and keeps the log directory).
vm_failed() {
  local label="$1" pid="$2" log="$3" reason="$4" dir
  dir=$(dirname "$log")
  progress_end_line
  vm_stop "$pid"
  {
    echo "prepare.sh: $label failed: $reason"
    echo 'Last 20 lines of the serial log (escape sequences removed):'
    serial_strip < "$log" 2>/dev/null | LC_ALL=C grep -av '^[[:space:]]*$' | tail -n 20 | sed 's/^/  | /' || true
    echo "Log directory: $dir (full serial log: $log)"
    if [[ -s "$dir/qemu.stderr" ]]; then echo 'QEMU error output:'; sed 's/^/  | /' "$dir/qemu.stderr"; fi
    echo 'What to check first:'
    echo "  - The build VM needs the Debian mirror. Proxy in use: $(proxy_describe)."
    echo '    Set it with --proxy URL or the https_proxy variable (the VM cannot see this shell).'
    echo '  - Read the whole serial log above for the first error.'
    echo '  - Or build the image on a machine with Internet access and copy images/ here.'
  } >&2
}

# watch_vm LABEL PID LOG DONE_RE WAIT_EXIT STALL_ABORT FAILURES PHASES
#   Poll the serial LOG of the VM PID every second until the success marker
#   DONE_RE (and, if WAIT_EXIT is 1, the exit of the VM) or a failure. Returns 0
#   on success; on failure it has stopped the VM, printed the report and
#   returns 1. STALL_ABORT: seconds without any output after which the VM is
#   stopped (0: only warn). FAILURES and PHASES name the arrays above.
watch_vm() {
  local label="$1" pid="$2" log="$3" done_re="$4" wait_exit="$5" stall_abort="$6"
  local -n failures="$7" phases="$8"
  local dir norm start=$SECONDS size last_size=-1 last_growth=$SECONDS
  local percent=0 phase='Starting the VM' done_seen=0 alive elapsed idle
  local last_report=-1000 stall_warned=0 entry pct text re f line
  local tty=0
  if [[ -t 1 ]]; then tty=1; fi
  dir=$(dirname "$log"); norm="$dir/.serial.normalized"
  [[ -e "$log" ]] || : > "$log"
  while :; do
    alive=1
    kill -0 "$pid" 2>/dev/null || alive=0
    size=$(stat -c %s "$log" 2>/dev/null || echo 0)
    if (( size != last_size )); then
      last_size=$size; last_growth=$SECONDS; stall_warned=0
      serial_strip < "$log" | tr -d ' \t\n' > "$norm"
      for f in "${failures[@]}"; do
        if serial_has "$norm" "${f// /}"; then
          vm_failed "$label" "$pid" "$log" "the serial log shows an error: $f"
          return 1
        fi
      done
      for entry in "${phases[@]}"; do
        IFS=@ read -r pct text re <<< "$entry"
        if (( pct > percent )) && serial_has "$norm" "$re"; then percent=$pct; phase=$text; fi
      done
      if (( ! done_seen )) && serial_has "$norm" "$done_re"; then done_seen=1; fi
    fi
    if (( done_seen )) && { (( ! wait_exit )) || (( ! alive )); }; then
      line="$(progress_gauge 100) 100%  Done  $(printf '%02d:%02d' $(( (SECONDS - start) / 60 )) $(( (SECONDS - start) % 60 )))"
      if (( tty )); then printf '\r\033[K%s\n' "$line"; else echo "$line"; fi
      PREPARE_LINE_OPEN=0
      return 0
    fi
    if (( ! alive )); then
      vm_failed "$label" "$pid" "$log" 'the VM stopped before the end of the build'
      return 1
    fi
    elapsed=$(( SECONDS - start )); idle=$(( SECONDS - last_growth ))
    if (( elapsed >= PREPARE_VM_TIMEOUT )); then
      vm_failed "$label" "$pid" "$log" "no end of build after $PREPARE_VM_TIMEOUT seconds (total limit)"
      return 1
    fi
    if (( stall_abort > 0 && idle >= stall_abort )); then
      vm_failed "$label" "$pid" "$log" "no progress for $idle seconds (the serial log has not grown)"
      return 1
    fi
    if (( idle >= PREPARE_STALL_WARN && ! stall_warned )); then
      progress_end_line
      echo "  Warning: no serial output for $idle seconds; the VM may be waiting. Log: $log"
      stall_warned=1
    fi
    if (( tty || elapsed - last_report >= 30 )); then
      line="$(progress_gauge "$percent") $(printf '%3d' "$percent")%  $phase  $(printf '%02d:%02d' $(( elapsed / 60 )) $(( elapsed % 60 )))  log $(( size / 1024 )) KB"
      if (( tty )); then printf '\r\033[K%s' "$line"; PREPARE_LINE_OPEN=1; else echo "$line"; fi
      last_report=$elapsed
    fi
    sleep 1
  done
}
