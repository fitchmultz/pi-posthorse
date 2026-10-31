#!/usr/bin/env bash
set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
source_sha="$(git rev-parse --verify 'HEAD^{commit}')"
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Release controls require a clean candidate checkout.' >&2
  exit 1
fi

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/posthorse-release-quality.XXXXXX")"
worktree="$scratch/checkout"
evidence="${PI_RELEASE_QUALITY_EVIDENCE:-$scratch/evidence}"
mkdir -p "$evidence"
evidence="$(cd "$evidence" && pwd -P)"
added=0
cleanup() {
  local status=$?
  trap - EXIT
  cd "$source_root" || exit 1
  if (( added )) && ! git worktree remove --force "$worktree"; then
    printf 'Could not remove disposable worktree: %s\n' "$worktree" >&2
    exit 1
  fi
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT

git -C "$source_root" worktree add --detach "$worktree" "$source_sha"
added=1
cd "$worktree"
printf 'source=%s\ntree=%s\n' "$source_sha" "$(git rev-parse 'HEAD^{tree}')" | tee "$evidence/source.txt"
npm ci --ignore-scripts --no-audit
npm run quality:prepare

run_command() {
  local name=$1 script=$2 status=0
  printf '\n--- %s: npm run %s ---\n' "$name" "$script"
  npm run "$script" > "$evidence/$name.raw.log" 2>&1 || status=$?
  if ! node --input-type=module - "$evidence/$name.raw.log" "$evidence/$name.log" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
const output = stripVTControlCharacters(readFileSync(process.argv[2], "utf8"));
writeFileSync(process.argv[3], output);
process.stdout.write(output);
NODE
  then
    printf 'Could not retain %s output.\n' "$name" >&2
    return 255
  fi
  return "$status"
}

expect_success() {
  if ! run_command "$1" "$2"; then
    printf '%s: expected success.\n' "$1" >&2
    exit 1
  fi
}

expect_rejection() {
  local name=$1 script=$2 status expected
  shift 2
  if run_command "$name" "$script"; then
    printf '%s: expected rejection.\n' "$name" >&2
    exit 1
  else
    status=$?
  fi
  if (( status >= 128 )); then
    printf '%s: command terminated or could not retain output.\n' "$name" >&2
    exit 1
  fi
  for expected in "$@"; do
    if ! grep -Fq -- "$expected" "$evidence/$name.log"; then
      printf '%s: missing expected diagnostic: %s\n' "$name" "$expected" >&2
      exit 1
    fi
  done
}

inject() {
  git restore --source="$source_sha" -- src/budget.ts
  printf '\n%s\n' "$1" >> src/budget.ts
}

inject 'const = 0;'
expect_rejection syntax verify 'Could not parse src/budget.ts: Unexpected token'

inject 'Promise.resolve(1);'
expect_rejection semantic verify 'src/budget.ts:' 'promise(catch-or-return)' \
  'typescript(no-floating-promises)' 'Found 0 warnings and 2 errors.'

inject 'export const releaseGateNumber: number = "not a number";'
expect_rejection compiler-tsc check 'src/budget.ts(' 'error TS2322:'
if [[ "$(grep -Ec 'error TS[0-9]+:' "$evidence/compiler-tsc.log")" != 1 ]]; then
  printf '%s\n' 'compiler-tsc: unexpected compiler diagnostics.' >&2
  exit 1
fi
expect_rejection compiler verify 'src/budget.ts:' 'typescript(TS2322)' \
  'Found 0 warnings and 1 error.'

inject 'export const releaseGateFormat=1;'
expect_rejection format verify 'src/budget.ts' 'Found 0 warnings and 0 errors.' \
  'Format issues found in above 1 files.'

inject $'const test = () => Promise.resolve(1);\ntest();'
expect_rejection allowance-local-test verify 'src/budget.ts:' \
  'typescript(no-floating-promises)' 'Found 0 warnings and 1 error.'

inject $'const registration = async () => 1;\nregistration();'
expect_rejection allowance-ordinary-async verify 'src/budget.ts:' \
  'typescript(no-floating-promises)' 'Found 0 warnings and 1 error.'

inject $'var releaseGateValue=1;\nexport const releaseGateFix=releaseGateValue;'
expect_success lint-fix-first lint:fix
expect_success format-first format
if grep -Fq 'var releaseGateValue' src/budget.ts; then
  printf '%s\n' 'Safe lint fix did not change the input.' >&2
  exit 1
fi
if [[ "$(git diff --name-only)" != 'src/budget.ts' ]]; then
  printf '%s\n' 'Safe fixes changed files outside the control.' >&2
  exit 1
fi
git diff --binary > "$evidence/fix-first.diff"
expect_success lint-fix-second lint:fix
expect_success format-second format
git diff --binary > "$evidence/fix-second.diff"
if ! cmp -s "$evidence/fix-first.diff" "$evidence/fix-second.diff"; then
  printf '%s\n' 'Safe lint and formatting did not converge.' >&2
  exit 1
fi
expect_success converged-lint lint
expect_success converged-format format:check
git restore --source="$source_sha" -- src/budget.ts
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Disposable worktree was not restored cleanly.' >&2
  exit 1
fi
printf '\n%s\n' 'Release quality controls passed.'
