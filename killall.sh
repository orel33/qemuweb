#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME="$ROOT/runtime"
DRY_RUN=0
if [[ ${1:-} == --dry-run && $# == 1 ]]; then
  DRY_RUN=1
elif (( $# != 0 )); then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

# Seuls les serveurs dont le répertoire de travail est ce projet sont concernés.
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

# SIGTERM déclenche la fermeture des sessions et des VM gérées par server.js.
signal_pids TERM server
if (( ! DRY_RUN )); then
  for _ in {1..12}; do
    [[ -z "$(matching_pids server)" ]] && break
    sleep 1
  done
  signal_pids KILL server
fi

# Récupère les QEMU de ce projet, y compris ceux orphelins ou en préparation.
signal_pids TERM qemu
if (( ! DRY_RUN )); then
  for _ in {1..3}; do
    [[ -z "$(matching_pids qemu)" ]] && break
    sleep 1
  done
  signal_pids KILL qemu
fi

# Une VM VirtualBox peut survivre au serveur qui l'a créée.
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
