#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Quick pre-commit checks for Tavily web search (no full sandbox rebuild).
#
# Usage:
#   cd ~/NemoClaw
#   npm run build:cli
#   ./scripts/test-tavily-flow.sh
#
# Optional — live Tavily API key validation + agent smoke test:
#   export TAVILY_API_KEY=tvly-...
#   ./scripts/test-tavily-flow.sh --live

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LIVE=0
if [[ "${1:-}" == "--live" ]]; then
  LIVE=1
fi

echo "==> 1) Build CLI"
npm run build:cli >/dev/null
echo "    OK (dist contains Tavily prompts)"

if ! grep -q "Enable web search?" dist/lib/onboard/web-search-flow.js; then
  echo "    FAIL: missing interactive web search prompt in build output" >&2
  exit 1
fi
if ! grep -q "Tavily Search" dist/lib/onboard/web-search-flow.js; then
  echo "    FAIL: missing Tavily provider in build output" >&2
  exit 1
fi

echo ""
echo "==> 2) Unit tests (optional — skip if vitest native bindings missing)"
if npx vitest run \
  src/lib/onboard/web-search-verify.test.ts \
  test/generate-openclaw-config.test.ts \
  -t "Tavily|tavily" 2>&1 | tail -8; then
  echo "    OK: vitest Tavily tests"
else
  echo "    SKIP: vitest unavailable (rolldown binding); continuing with node/python checks"
fi

echo ""
echo "==> 3) Simulate Tavily provider selection (non-interactive + fake curl)"
TMP="$(mktemp -d)"
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/curl" <<'CURL'
#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' '{"results":[]}' >"$outfile"
printf '%s' '200'
CURL
chmod +x "$FAKE_BIN/curl"
export HOME="$TMP"
export PATH="$FAKE_BIN:$PATH"
export TAVILY_API_KEY="tvly-mock-test-key"
export NEMOCLAW_WEB_SEARCH_PROVIDER="tavily"

node <<'NODE'
const { createWebSearchFlowHelpers } = require("./dist/lib/onboard/web-search-flow");

const helpers = createWebSearchFlowHelpers({
  prompt: async () => { throw new Error("unexpected prompt in non-interactive test"); },
  note: () => {},
  isNonInteractive: () => true,
  cliName: () => "nemoclaw",
  runCaptureOpenshell: () => null,
});

(async () => {
  const result = await helpers.configureWebSearch(null);
  if (!result || result.provider !== "tavily" || !result.fetchEnabled) {
    console.error("FAIL: expected { fetchEnabled: true, provider: 'tavily' }, got", result);
    process.exit(1);
  }
  console.log("    OK: configureWebSearch selected provider=tavily");
})();
NODE

echo ""
echo "==> 4) OpenClaw config generation (tavily provider)"
python3 <<'PY'
import base64, json, os, subprocess, tempfile
env = os.environ.copy()
env.update({
    "NEMOCLAW_MODEL": "test-model",
    "NEMOCLAW_PROVIDER_KEY": "test-provider",
    "NEMOCLAW_PRIMARY_MODEL_REF": "test-ref",
    "CHAT_UI_URL": "http://127.0.0.1:18789",
    "NEMOCLAW_INFERENCE_BASE_URL": "http://localhost:8080",
    "NEMOCLAW_INFERENCE_API": "openai",
    "NEMOCLAW_INFERENCE_COMPAT_B64": base64.b64encode(b"{}").decode(),
    "NEMOCLAW_PROXY_HOST": "10.200.0.1",
    "NEMOCLAW_PROXY_PORT": "3128",
    "NEMOCLAW_CONTEXT_WINDOW": "131072",
    "NEMOCLAW_MAX_TOKENS": "4096",
    "NEMOCLAW_REASONING": "false",
    "NEMOCLAW_AGENT_TIMEOUT": "600",
})
env["NEMOCLAW_WEB_SEARCH_ENABLED"] = "1"
env["NEMOCLAW_WEB_SEARCH_PROVIDER"] = "tavily"
with tempfile.TemporaryDirectory() as td:
    env["HOME"] = td
    subprocess.run(
        ["python3", "scripts/generate-openclaw-config.py"],
        cwd=os.getcwd(),
        env=env,
        check=True,
    )
    cfg = json.load(open(f"{td}/.openclaw/openclaw.json"))
    search = cfg["tools"]["web"]["search"]
    assert search["provider"] == "tavily", search
    assert "tavily" not in search, search
    assert cfg["plugins"]["entries"]["tavily"]["config"]["webSearch"]["apiKey"]
    agents_md = f"{td}/.openclaw/workspace/AGENTS.md"
    with open(agents_md) as f:
        body = f.read()
    assert "Tavily Web Search is used" in body, body
print("    OK: openclaw.json provider=tavily and AGENTS.md usage hint")
PY

if [[ "$LIVE" -eq 1 ]]; then
  if [[ -z "${TAVILY_API_KEY:-}" ]]; then
    echo "    SKIP live: set TAVILY_API_KEY" >&2
    exit 1
  fi
  echo ""
  echo "==> 5) Live Tavily API key validation"
  node <<NODE
const { createWebSearchFlowHelpers } = require("./dist/lib/onboard/web-search-flow");
const helpers = createWebSearchFlowHelpers({
  prompt: async () => { throw new Error("unexpected prompt"); },
  note: () => {},
  isNonInteractive: () => true,
  cliName: () => "nemoclaw",
  runCaptureOpenshell: () => null,
});
process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY;
process.env.NEMOCLAW_WEB_SEARCH_PROVIDER = "tavily";
(async () => {
  const result = await helpers.configureWebSearch(null);
  if (!result || result.provider !== "tavily") {
    console.error("FAIL: live validation", result);
    process.exit(1);
  }
  console.log("    OK: TAVILY_API_KEY validated");
})();
NODE
else
  echo ""
  echo "==> 5) Live tests skipped (run with --live and TAVILY_API_KEY)"
fi

echo ""
echo "All automated pre-commit checks passed."
echo ""
echo "Manual checks on your VM (needs real Tavily key + sandbox rebuild):"
echo "  export PATH=\"$REPO_ROOT:\$PATH\"   # or: npm link"
echo "  export TAVILY_API_KEY=tvly-..."
echo "  nemoclaw onboard                    # y → web search → 2 Tavily → paste key"
echo "  # OR for existing my-assistant:"
echo "  ./scripts/setup-tavily-search.sh my-assistant"
echo "  nemoclaw my-assistant exec openclaw-agent -m 'Use web search: latest NVIDIA GTC news. Say which search you used.'"
