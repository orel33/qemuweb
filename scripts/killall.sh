#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUNTIME="$ROOT/runtime"
DRY_RUN=0
if [[ ${1:-} == --dry-run && $# == 1 ]]; then
  DRY_RUN=1
elif (( $# != 0 )); then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

# Only servers whose working directory is this project are affected.
matching_pids() {
  local kind="$1" proc pid exe cwd arg matched
  if [[ -d /proc && -e /proc/version ]]; then
    local -a args
    for proc in /proc/[0-9]*; do
      [[ -d "$proc" ]] || continue
      pid="${proc##*/}"
      [[ "$pid" != "$$" && -r "$proc/cmdline" ]] || continue
      exe="$(readlink -f -- "$proc/exe" 2>/dev/null || true)"
      args=()
      mapfile -d '' -t args < "$proc/cmdline" 2>/dev/null || continue
      (( ${#args[@]} )) || continue
      if [[ "$kind" == server ]]; then
        [[ "${exe##*/}" == node ]] || continue
        cwd="$(readlink -f -- "$proc/cwd" 2>/dev/null || true)"
        matched=0
        for arg in "${args[@]:1}"; do
          if [[ "$arg" == "$ROOT/server.js" || ( "$arg" == server.js && "$cwd" == "$ROOT" ) ]]; then
            matched=1
          fi
        done
        (( matched )) && printf '%s\n' "$pid"
      else
        [[ "${exe##*/}" == qemu-system-x86_64 ]] || continue
        for arg in "${args[@]:1}"; do
          if [[ "$arg" == *"$RUNTIME/"* || "$arg" == *"$ROOT/images/"* ]]; then
            printf '%s\n' "$pid"
            break
          fi
        done
      fi
    done
  else
    # Fallback using ps for systems without /proc (such as macOS)
    local p_pid p_cmd
    while IFS= read -r line; do
      p_pid="$(echo "$line" | awk '{print $1}')"
      p_cmd="${line#*"$p_pid"}"
      [[ "$p_pid" != "$$" && -n "$p_pid" ]] || continue
      if [[ "$kind" == server ]]; then
        if [[ "$p_cmd" == *node*server.js* && ( "$p_cmd" == *"$ROOT"* || "$p_cmd" == *server.js* ) ]]; then
          printf '%s\n' "$p_pid"
        fi
      else
        if [[ "$p_cmd" == *qemu-system-x86_64* && ( "$p_cmd" == *"$RUNTIME/"* || "$p_cmd" == *"$ROOT/images/"* ) ]]; then
          printf '%s\n' "$p_pid"
        fi
      fi
    done < <(ps -eo pid,command 2>/dev/null || true)
  fi
}

signal_pids() {
  local signal="$1" kind="$2" pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if (( DRY_RUN )); then echo "Dry run: signal $signal to $kind PID $pid"
    else echo "Signal $signal: $kind PID $pid"; fi
    if (( ! DRY_RUN )); then kill "-$signal" "$pid" 2>/dev/null || true; fi
  done < <(matching_pids "$kind")
}

# SIGTERM triggers shutting down sessions and VMs managed by server.js.
signal_pids TERM server
if (( ! DRY_RUN )); then
  for _ in {1..12}; do
    [[ -z "$(matching_pids server)" ]] && break
    sleep 1
  done
  signal_pids KILL server
fi

# Collect QEMU processes for this project, including orphaned ones or during preparation.
signal_pids TERM qemu
if (( ! DRY_RUN )); then
  for _ in {1..3}; do
    [[ -z "$(matching_pids qemu)" ]] && break
    sleep 1
  done
  signal_pids KILL qemu
fi

# A VirtualBox VM can survive the server that created it.
if command -v VBoxManage >/dev/null 2>&1; then
  while IFS= read -r entry; do
    [[ "$entry" =~ ^\"(qemuweb-[0-9]+-[A-Za-z0-9_-]+)\"[[:space:]] ]] || continue
    vm="${BASH_REMATCH[1]}"
    info="$(VBoxManage showvminfo "$vm" --machinereadable 2>/dev/null || true)"
    [[ "$info" == *"$RUNTIME/"* ]] || continue
    echo "VirtualBox: $vm"
    if (( ! DRY_RUN )); then
      VBoxManage controlvm "$vm" poweroff >/dev/null 2>&1 || true
      VBoxManage unregistervm "$vm" >/dev/null
    fi
  done < <(VBoxManage list vms 2>/dev/null || true)
  if (( ! DRY_RUN )) && [[ -d "$RUNTIME" ]]; then
    while IFS= read -r -d '' vdi; do
      VBoxManage closemedium disk "$vdi" --delete >/dev/null 2>&1 || true
    done < <(find "$RUNTIME" -type f \( -name 'disk.vdi' -o -name 'qemuweb-*.vdi' \) -print0)
  fi
fi

if (( ! DRY_RUN )) && { [[ -n "$(matching_pids server)" ]] || [[ -n "$(matching_pids qemu)" ]]; }; then
  echo 'Project processes are still running; cleanup cancelled.' >&2
  exit 1
fi

if (( DRY_RUN )); then echo 'Dry run complete.'
else echo 'Project instances stopped.'; fi
