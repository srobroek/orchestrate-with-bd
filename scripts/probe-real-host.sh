#!/bin/sh
# Manual pre-release probe: a real OMP session loads companion plugins and emits the run header.
set -eu
repo=${1:-$(pwd)}
command -v omp >/dev/null 2>&1 || { echo 'FAIL: omp is required on PATH' >&2; exit 1; }
command -v bd >/dev/null 2>&1 || { echo 'FAIL: bd is required on PATH' >&2; exit 1; }
command -v mktemp >/dev/null 2>&1 || { echo 'FAIL: mktemp is required on PATH' >&2; exit 1; }
scratch=$(mktemp -d "${TMPDIR:-/tmp}/omp-real-host.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/repo"
git -C "$scratch/repo" init -q -b main
printf '{"name":"probe","private":true}\n' >"$scratch/repo/package.json"
git -C "$scratch/repo" add package.json
git -C "$scratch/repo" -c user.name=probe -c user.email=probe@example.invalid commit -q -m init
(
  cd "$scratch/repo"
  bd init --skip-hooks --skip-agents --prefix probe >/dev/null
  omp -p 'orchestrate probe: report the run header and stop.' --session-dir "$scratch/session" </dev/null >"$scratch/output" 2>&1
)
if grep -Fq 'orc-run-header' "$scratch/output"; then
  echo 'PASS: real OMP host emitted the orchestrate run header'
else
  cat "$scratch/output" >&2
  echo 'FAIL: real OMP host did not emit the orchestrate run header' >&2
  exit 1
fi
