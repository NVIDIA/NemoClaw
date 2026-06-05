#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes sandbox secret-boundary smoke:
#   - builds the real Hermes sandbox image unless NEMOCLAW_HERMES_TEST_IMAGE is set
#   - inspects the built Hermes image for raw secret-shaped .env values
#   - verifies remote platform toolsets preserve Hermes capabilities
#   - verifies managed tool gateway images keep auth out of sandbox env/config
#   - proves startup rejects newly introduced raw secret-shaped .env values

set -euo pipefail

LOG_PATH="${NEMOCLAW_HERMES_SECRET_BOUNDARY_LOG:-/tmp/nemoclaw-hermes-sandbox-secret-boundary.log}"
: >"$LOG_PATH"
exec > >(tee -a "$LOG_PATH") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  exit 1
}

shell_quote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  docker info >/dev/null 2>&1 || fail "docker daemon is not available"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_ID="${GITHUB_RUN_ID:-local}-$$"
IMAGE="${NEMOCLAW_HERMES_TEST_IMAGE:-nemoclaw-hermes-secret-boundary:${RUN_ID}}"
BASE_IMAGE_FROM_ENV="${NEMOCLAW_HERMES_BASE_IMAGE:-${HERMES_BASE_IMAGE:-}}"
BASE_IMAGE="${BASE_IMAGE_FROM_ENV:-nemoclaw-hermes-secret-boundary-base:${RUN_ID}}"
MANAGED_IMAGE="${NEMOCLAW_HERMES_MANAGED_TEST_IMAGE:-nemoclaw-hermes-secret-boundary-managed:${RUN_ID}}"
MANAGED_PRESETS_B64="$(
  python3 - <<'PY'
import base64
import json

print(
    base64.b64encode(
        json.dumps(
            ["nous-web", "nous-audio", "nous-browser", "nous-image", "nous-code"],
            separators=(",", ":"),
        ).encode("utf-8")
    ).decode("ascii")
)
PY
)"

build_image_if_needed() {
  if [ -n "${NEMOCLAW_HERMES_TEST_IMAGE:-}" ]; then
    info "Using prebuilt Hermes image ${IMAGE}"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "prebuilt image not found: ${IMAGE}"
    return 0
  fi

  if [ -z "$BASE_IMAGE_FROM_ENV" ]; then
    info "Building Hermes base image ${BASE_IMAGE}"
    docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" -t "$BASE_IMAGE" "$REPO_ROOT" \
      || fail "failed to build Hermes base image"
  else
    info "Using configured Hermes base image ${BASE_IMAGE}"
  fi

  info "Building Hermes production image ${IMAGE}"
  docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    -t "$IMAGE" \
    "$REPO_ROOT" \
    || fail "failed to build Hermes production image"
}

build_managed_image_if_needed() {
  if [ -n "${NEMOCLAW_HERMES_MANAGED_TEST_IMAGE:-}" ]; then
    info "Using prebuilt managed-tool Hermes image ${MANAGED_IMAGE}"
    docker image inspect "$MANAGED_IMAGE" >/dev/null 2>&1 \
      || fail "prebuilt managed-tool image not found: ${MANAGED_IMAGE}"
    return 0
  fi

  if [ -z "$BASE_IMAGE_FROM_ENV" ] && ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    info "Building Hermes base image ${BASE_IMAGE} for managed-tool variant"
    docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" -t "$BASE_IMAGE" "$REPO_ROOT" \
      || fail "failed to build Hermes base image for managed-tool variant"
  else
    info "Using Hermes base image ${BASE_IMAGE} for managed-tool variant"
  fi

  info "Building Hermes managed-tool production image ${MANAGED_IMAGE}"
  docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    --build-arg "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1" \
    --build-arg "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=${MANAGED_PRESETS_B64}" \
    -t "$MANAGED_IMAGE" \
    "$REPO_ROOT" \
    || fail "failed to build Hermes managed-tool production image"
}

inspect_image_boundary() {
  local image="$1"
  info "Inspecting Hermes sandbox boundary in ${image}"
  docker run --rm --entrypoint python3 "$image" - <<'PY'
import re
import sys
from pathlib import Path

secret_key_re = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
slack_alias_re = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
allowed_nonsecret_keys = {"API_SERVER_HOST", "API_SERVER_PORT"}
allowed_literals = {"", "[STRIPPED_BY_MIGRATION]"}
required_remote_toolsets = {
    "web",
    "browser",
    "terminal",
    "file",
    "code_execution",
    "vision",
    "image_gen",
    "skills",
    "todo",
    "memory",
    "session_search",
    "delegation",
    "cronjob",
    "nemoclaw",
    "audio",
}


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def env_violations(path: Path) -> list[str]:
    violations: list[str] = []
    for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if key in allowed_nonsecret_keys:
            continue
        if not secret_key_re.search(key):
            continue
        value = unquote(value)
        if (
            value in allowed_literals
            or value.startswith("openshell:resolve:env:")
            or slack_alias_re.fullmatch(value)
        ):
            continue
        violations.append(f"{key} line {lineno}")
    return violations


def parse_platform_toolsets(text: str) -> dict[str, list[str]]:
    toolsets: dict[str, list[str]] = {}
    in_block = False
    block_indent = 0
    current: str | None = None
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if stripped == "platform_toolsets:":
            in_block = True
            block_indent = indent
            continue
        if not in_block:
            continue
        if indent <= block_indent and not stripped.startswith("- "):
            break
        key_match = re.fullmatch(r"([A-Za-z0-9_-]+):(?:\s*\[\])?", stripped)
        if key_match:
            current = key_match.group(1)
            toolsets[current] = []
            continue
        if stripped.startswith("- ") and current:
            toolsets[current].append(unquote(stripped[2:]))
    return toolsets


env_path = Path("/sandbox/.hermes/.env")
config_path = Path("/sandbox/.hermes/config.yaml")
if env_path.is_symlink():
    print(f"{env_path} is a symlink", file=sys.stderr)
    sys.exit(1)
if not env_path.is_file():
    print(f"{env_path} missing", file=sys.stderr)
    sys.exit(1)
if not config_path.is_file():
    print(f"{config_path} missing", file=sys.stderr)
    sys.exit(1)

violations = env_violations(env_path)
if violations:
    print("raw secret-shaped Hermes .env values:", ", ".join(violations), file=sys.stderr)
    sys.exit(1)

toolsets = parse_platform_toolsets(config_path.read_text(encoding="utf-8"))
api_server_toolsets = set(toolsets.get("api_server", []))
if not api_server_toolsets:
    print("platform_toolsets.api_server missing", file=sys.stderr)
    sys.exit(1)
missing = sorted(required_remote_toolsets - api_server_toolsets)
if missing:
    print(f"platform_toolsets.api_server missing expected Hermes toolsets: {missing}", file=sys.stderr)
    sys.exit(1)
if "no_mcp" in api_server_toolsets:
    print("platform_toolsets.api_server unexpectedly disables default MCP servers with no_mcp", file=sys.stderr)
    sys.exit(1)
PY
  pass "Built Hermes image has no raw secret-shaped .env values and preserves remote toolsets"
}

inspect_managed_tool_boundary() {
  local image="$1"
  info "Inspecting Hermes managed-tool gateway boundary in ${image}"
  docker run --rm --entrypoint python3 "$image" - <<'PY'
import re
import sys
from pathlib import Path

secret_key_re = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)")
slack_alias_re = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
allowed_nonsecret_keys = {"API_SERVER_HOST", "API_SERVER_PORT"}
allowed_literals = {"", "[STRIPPED_BY_MIGRATION]"}
required_env_lines = {
    "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
    "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
    "OPENAI_AUDIO_GATEWAY_URL=http://host.openshell.internal:11436/openai-audio",
    "BROWSER_USE_GATEWAY_URL=http://host.openshell.internal:11436/browser-use",
    "FAL_QUEUE_GATEWAY_URL=http://host.openshell.internal:11436/fal-queue",
    "MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal",
}
required_config_fragments = [
    "backend: firecrawl",
    "provider: openai",
    "cloud_provider: browser-use",
    "image_gen:",
    "backend: modal",
    "modal_mode: managed",
    "tts:",
]


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def env_violations(path: Path) -> list[str]:
    violations: list[str] = []
    for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key in allowed_nonsecret_keys:
            continue
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if not secret_key_re.search(key):
            continue
        value = unquote(value)
        if (
            value in allowed_literals
            or value.startswith("openshell:resolve:env:")
            or slack_alias_re.fullmatch(value)
        ):
            continue
        violations.append(f"{key} line {lineno}")
    return violations


env_path = Path("/sandbox/.hermes/.env")
config_path = Path("/sandbox/.hermes/config.yaml")
if not env_path.is_file() or env_path.is_symlink():
    print(f"{env_path} missing, not a file, or unsafe symlink", file=sys.stderr)
    sys.exit(1)
if not config_path.is_file():
    print(f"{config_path} missing", file=sys.stderr)
    sys.exit(1)

env_text = env_path.read_text(encoding="utf-8")
config_text = config_path.read_text(encoding="utf-8")
env_lines = set(env_text.splitlines())
violations = env_violations(env_path)
if violations:
    print("raw secret-shaped managed-tool .env values:", ", ".join(violations), file=sys.stderr)
    sys.exit(1)

missing_env = sorted(required_env_lines - env_lines)
missing_config = [fragment for fragment in required_config_fragments if fragment not in config_text]
for forbidden in (
    "TOOL_GATEWAY_USER_TOKEN",
    "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN=",
    "raw-refresh-token",
):
    if forbidden in env_text or forbidden in config_text:
        print(f"managed-tool sandbox config contains forbidden token surface: {forbidden}", file=sys.stderr)
        sys.exit(1)

if missing_env:
    print("managed-tool .env missing expected gateway lines: " + ", ".join(missing_env), file=sys.stderr)
    sys.exit(1)
if missing_config:
    print("managed-tool config.yaml missing expected fragments: " + ", ".join(missing_config), file=sys.stderr)
    sys.exit(1)
PY
  pass "Managed-tool Hermes image keeps gateway auth out of sandbox while preserving tool config"
}

assert_startup_rejects_env_entry() {
  local assignment="$1"
  local key="$2"
  local value="$3"
  local quoted_assignment output script

  quoted_assignment="$(shell_quote "$assignment")"
  script="set -euo pipefail; printf '%s\n' ${quoted_assignment} >> /sandbox/.hermes/.env; exec /usr/local/bin/nemoclaw-start true"

  info "Verifying Hermes startup rejects ${key}"
  if output="$(docker run --rm --user sandbox --entrypoint /bin/bash "$IMAGE" -lc "$script" 2>&1)"; then
    printf '%s\n' "$output"
    fail "Hermes startup accepted ${key}"
  fi
  printf '%s\n' "$output" | grep -F "raw secret-shaped values" >/dev/null \
    || fail "Hermes startup rejection did not mention raw secret-shaped values"
  printf '%s\n' "$output" | grep -F "$key" >/dev/null \
    || fail "Hermes startup rejection did not name ${key}"
  if printf '%s\n' "$output" | grep -F "$value" >/dev/null; then
    fail "Hermes startup rejection printed the raw value for ${key}"
  fi
  pass "Hermes startup rejects ${key} without echoing its value"
}

assert_startup_rejects_runtime_env_entry() {
  local assignment="$1"
  local key="$2"
  local value="$3"
  local output

  info "Verifying Hermes startup rejects runtime env ${key}"
  if output="$(docker run --rm --user sandbox --env "$assignment" --entrypoint /usr/local/bin/nemoclaw-start "$IMAGE" true 2>&1)"; then
    printf '%s\n' "$output"
    fail "Hermes startup accepted runtime env ${key}"
  fi
  printf '%s\n' "$output" | grep -F "process environment" >/dev/null \
    || fail "Hermes startup rejection did not mention process environment"
  printf '%s\n' "$output" | grep -F "$key" >/dev/null \
    || fail "Hermes startup rejection did not name ${key}"
  if printf '%s\n' "$output" | grep -F "$value" >/dev/null; then
    fail "Hermes startup rejection printed the raw value for runtime env ${key}"
  fi
  pass "Hermes startup rejects runtime env ${key} without echoing its value"
}

require_docker
build_image_if_needed
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image not found: ${IMAGE}"
build_managed_image_if_needed
docker image inspect "$MANAGED_IMAGE" >/dev/null 2>&1 || fail "image not found: ${MANAGED_IMAGE}"

inspect_image_boundary "$IMAGE"
inspect_managed_tool_boundary "$MANAGED_IMAGE"
assert_startup_rejects_env_entry \
  "DEVTEST_API_TOKEN=01234567-89ab-cdef-0123-456789abcdef" \
  "DEVTEST_API_TOKEN" \
  "01234567-89ab-cdef-0123-456789abcdef"
assert_startup_rejects_env_entry \
  "INTERNAL_API=01234567-89ab-cdef-0123-456789abcdef" \
  "INTERNAL_API" \
  "01234567-89ab-cdef-0123-456789abcdef"
assert_startup_rejects_env_entry \
  "OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE" \
  "OPENAI_API_KEY" \
  "sk-OPENSHELL-PROXY-REWRITE"
assert_startup_rejects_runtime_env_entry \
  "DEVTEST_API_TOKEN=01234567-89ab-cdef-0123-456789abcdef" \
  "DEVTEST_API_TOKEN" \
  "01234567-89ab-cdef-0123-456789abcdef"
assert_startup_rejects_runtime_env_entry \
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN=raw-refresh-token" \
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN" \
  "raw-refresh-token"

pass "Hermes sandbox secret-boundary smoke passed"
