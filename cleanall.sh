#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME="$ROOT/runtime"
IMAGES="$ROOT/images"
DRY_RUN=0
CLEAN_IMAGES=0

for option in "$@"; do
  case "$option" in
    --dry-run) DRY_RUN=1 ;;
    --images) CLEAN_IMAGES=1 ;;
    *) echo "Usage : $0 [--dry-run] [--images]" >&2; exit 2 ;;
  esac
done

if (( DRY_RUN )); then
  "$ROOT/killall.sh" --dry-run
else
  "$ROOT/killall.sh"
fi

clean_directory() {
  local directory="$1" entry
  [[ -d "$directory" && ! -L "$directory" ]] || return 0
  while IFS= read -r -d '' entry; do
    if (( DRY_RUN )); then echo "Suppression prévue : $entry"
    else rm -rf -- "$entry"; fi
  done < <(find "$directory" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print0)
}

clean_directory "$RUNTIME"
if (( CLEAN_IMAGES )); then clean_directory "$IMAGES"; fi

if (( DRY_RUN )); then echo 'Simulation terminée : aucun fichier supprimé.'
elif (( CLEAN_IMAGES )); then echo 'Fichiers temporaires et images préparées supprimés.'
else echo 'Fichiers temporaires supprimés ; images préparées conservées.'; fi
