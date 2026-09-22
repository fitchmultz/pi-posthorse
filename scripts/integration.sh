#!/usr/bin/env bash
# Runs test/integration/posthorse-in-pi.test.ts inside the fitchmultz/pi fork's own vitest setup, so the real
# extension is loaded by the real extension runner against the faux provider. No API keys are needed.
#
#   PI_FORK=/path/to/fitchmultz/pi scripts/integration.sh      (default: ../pi, built with `npm run build`)
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
fork=$(cd "${PI_FORK:-$here/../pi}" && pwd)
agent="$fork/packages/coding-agent"
[ -f "$agent/test/suite/harness.ts" ] || { echo "Pi fork test harness not found under $fork; set PI_FORK" >&2; exit 1; }
[ -d "$fork/packages/ai/src/providers/data" ] || { echo "Model data missing; run 'npm run build' in $fork first" >&2; exit 1; }

target="$agent/test/posthorse-integration.test.ts"
configDir=$(mktemp -d "$agent/.posthorse-vitest.XXXXXX")
trap 'rm -f "$target" "$configDir/vitest.config.ts"; rmdir "$configDir"' EXIT
# Posthorse lives outside the fork, so pin its SDK import to the same source graph as the harness.
cat > "$configDir/vitest.config.ts" <<'EOF'
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../vitest.config.ts";

export default mergeConfig(baseConfig, defineConfig({
	resolve: {
		alias: [{
			find: /^@earendil-works\/pi-coding-agent$/,
			replacement: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
		}],
	},
}));
EOF
cp "$here/test/integration/posthorse-in-pi.test.ts" "$target"
cd "$agent"
POSTHORSE_INDEX="$here/index.ts" npx --no-install vitest run --config "$configDir/vitest.config.ts" test/posthorse-integration.test.ts
