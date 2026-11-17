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

# Only the processes that belong to this project are matched (by path or working directory).
matching_pids() {
  local kind="$1" proc pid exe cwd arg matched
  local -a args
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    [[ "$pid" != "$$" && -r "$proc/cmdline" ]] || continue
    exe="$(readlink -f -- "$proc/exe" 2>/dev/null || true)"
    args=()
    mapfile -d '' -t args < "$proc/cmdline" 2>/dev/null || continue
    (( ${#args[@]} )) || continue
    if [[ "$kind" == runner ]]; then
      # A runner of this project (./scripts/runner.sh: runner/main.js from the project directory).
      [[ "${exe##*/}" == node ]] || continue
      cwd="$(readlink -f -- "$proc/cwd" 2>/dev/null || true)"
      for arg in "${args[@]:1}"; do
        if [[ "$arg" == "$ROOT/runner/main.js" || ( "$arg" == runner/main.js && "$cwd" == "$ROOT" ) ]]; then printf '%s\n' "$pid"; break; fi
      done
    elif [[ "$kind" == server ]]; then
      [[ "${exe##*/}" == node ]] || continue
      cwd="$(readlink -f -- "$proc/cwd" 2>/dev/null || true)"
      matched=0
      for arg in "${args[@]:1}"; do
        if [[ "$arg" == "$ROOT/server.js" || ( "$arg" == server.js && "$cwd" == "$ROOT" ) ]]; then
          matched=1
        fi
      done
      (( matched )) && printf '%s\n' "$pid"
    elif [[ "$kind" == vde ]]; then
      # VDE switches and terminals of this project, left behind when server and runner are killed with KILL.
      [[ "${exe##*/}" == vde_switch || "${exe##*/}" == vdeterm ]] || continue
      cwd="$(readlink -f -- "$proc/cwd" 2>/dev/null || true)"
      if [[ "$cwd" == "$RUNTIME" || "$cwd" == "$RUNTIME/"* ]]; then printf '%s\n' "$pid"; continue; fi
      for arg in "${args[@]:1}"; do
        if [[ "$arg" == *"$RUNTIME/"* ]]; then printf '%s\n' "$pid"; break; fi
      done
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

# SIGTERM triggers the shutdown of the nodes (VMs and switches) managed by server.js.
signal_pids TERM server
if (( ! DRY_RUN )); then
  for _ in {1..12}; do
    [[ -z "$(matching_pids server)" ]] && break
    sleep 1
  done
  signal_pids KILL server
fi

# A runner keeps its nodes when its server stops (unless it was started with --exit-on-disconnect); SIGTERM stops them.
signal_pids TERM runner
if (( ! DRY_RUN )); then
  for _ in {1..12}; do
    [[ -z "$(matching_pids runner)" ]] && break
    sleep 1
  done
  signal_pids KILL runner
fi

# Collects the QEMU processes of this project, including orphaned ones and those used for preparation.
signal_pids TERM qemu
if (( ! DRY_RUN )); then
  for _ in {1..3}; do
    [[ -z "$(matching_pids qemu)" ]] && break
    sleep 1
  done
  signal_pids KILL qemu
fi

# VDE switches and terminals of this project that survived their server and runner.
signal_pids TERM vde
if (( ! DRY_RUN )); then
  for _ in {1..3}; do
    [[ -z "$(matching_pids vde)" ]] && break
    sleep 1
  done
  signal_pids KILL vde
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

if (( ! DRY_RUN )) && { [[ -n "$(matching_pids server)" ]] || [[ -n "$(matching_pids runner)" ]] || [[ -n "$(matching_pids qemu)" ]] || [[ -n "$(matching_pids vde)" ]]; }; then
  echo 'Project processes are still running; cleanup cancelled.' >&2
  exit 1
fi

if (( DRY_RUN )); then echo 'Dry run complete.'
else echo 'Project instances stopped.'; fi
