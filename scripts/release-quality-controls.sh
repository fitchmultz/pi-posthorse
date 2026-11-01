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
evidence="${PI_RELEASE_QUALITY_EVIDENCE:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/posthorse-quality-evidence.XXXXXX")}"
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
npm ci --ignore-scripts --no-audit
{
  printf 'source=%s\ntree=%s\n' "$source_sha" "$(git rev-parse 'HEAD^{tree}')"
  node --version
  npm --version
  npm ls --depth=0
} | tee "$evidence/source.txt"
printf 'Evidence: %s\n' "$evidence"

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

expect_gates() {
  local name=$1 failed=$2 gate status
  for gate in quality:policy quality:config lint:oxlint format:check check test build; do
    status=0
    if [[ ",$failed," == *",$gate,"* ]]; then
      status=1
    fi
    if ! grep -Fxq "Gate $gate: exit $status" "$evidence/$name.log"; then
      printf '%s: %s did not run with expected exit %s.\n' "$name" "$gate" "$status" >&2
      exit 1
    fi
  done
}

expect_verify_rejection() {
  local name=$1 failed=$2
  shift 2
  expect_rejection "$name" verify "$@"
  expect_gates "$name" "$failed"
}

restore_controls() {
  git restore --source="$source_sha" -- src/budget.ts test/posthorse.test.ts .oxlintrc.json
}

inject() {
  restore_controls
  printf '\n%s\n' "$1" >> src/budget.ts
  control_line="$(wc -l < src/budget.ts | tr -d '[:space:]')"
}

expect_success baseline verify
expect_gates baseline ''

inject 'debugger;'
expect_verify_rejection lint lint:oxlint "src/budget.ts:$control_line:" 'eslint(no-debugger)'

inject 'Promise.resolve(1);'
expect_verify_rejection semantic lint:oxlint "src/budget.ts:$control_line:" \
  'promise(catch-or-return)' 'typescript(no-floating-promises)'

inject 'export const releaseGateNumber: number = "not a number";'
expect_verify_rejection compiler check "src/budget.ts($control_line,14): error TS2322:"

inject 'export const releaseGateFormat=1;'
expect_verify_rejection format format:check 'src/budget.ts' \
  'Format issues found in above 1 files.'

restore_controls
printf '\n%s\n' $'nodeTest("release quality control: failed assertion", () => {\n\tassert.equal(1, 2);\n});' >> test/posthorse.test.ts
assertion_line=$(( $(wc -l < test/posthorse.test.ts) - 1 ))
expect_verify_rejection assertion test 'release quality control: failed assertion' \
  'ERR_ASSERTION' "test/posthorse.test.ts:$assertion_line:"

restore_controls
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = ".oxlintrc.json";
const config = JSON.parse(readFileSync(file, "utf8"));
config.categories.suspicious = "off";
writeFileSync(file, JSON.stringify(config));
NODE
npm run format > "$evidence/policy-format.log" 2>&1
expect_verify_rejection policy 'quality:policy,test' '.oxlintrc.json:categories differs'

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
expect_success converged verify
expect_gates converged ''
restore_controls
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Disposable worktree was not restored cleanly.' >&2
  exit 1
fi
printf '\n%s\n' 'Release quality controls passed.'
