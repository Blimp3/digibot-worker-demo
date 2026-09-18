#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

scan_args=(
  --hidden
  --glob '!.git/**'
  --glob '!node_modules/**'
  --glob '!pnpm-lock.yaml'
  --glob '!uv.lock'
  --glob '!scripts/scan-secrets.sh'
)

patterns=(
  '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
  '[0-9]{6,12}:[A-Za-z0-9_-]{30,}'
  'gh[opurs]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{50,}'
  'sk_live_[A-Za-z0-9]{20,}'
  'AKIA[0-9A-Z]{16}'
)

found=0
for pattern in "${patterns[@]}"; do
  if rg --files-with-matches --color never "${scan_args[@]}" -- "$pattern" .; then
    found=1
  fi
done

if [[ "$found" -ne 0 ]]; then
  printf 'Potential secret material found. Remove or replace it before committing.\n' >&2
  exit 1
fi
printf 'No high-confidence secret patterns found in tracked-source candidates.\n'
