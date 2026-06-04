#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes sandbox secret-boundary smoke:
#   - inspects the built Hermes image for raw secret-shaped .env values
#   - verifies remote platform toolsets cannot expose local sandbox tools
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

IMAGE="${NEMOCLAW_HERMES_TEST_IMAGE:-}"
if [ -z "$IMAGE" ]; then
  fail "NEMOCLAW_HERMES_TEST_IMAGE must point at a built Hermes sandbox image"
fi

inspect_image_boundary() {
  info "Inspecting Hermes sandbox boundary in ${IMAGE}"
  docker run --rm --entrypoint python3 "$IMAGE" - <<'PY'
import re
import sys
from pathlib import Path

secret_key_re = re.compile(r"(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)(_|$)")
slack_alias_re = re.compile(r"^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$")
allowed_literals = {"", "[STRIPPED_BY_MIGRATION]"}
forbidden_toolsets = {
    "terminal",
    "file",
    "code_execution",
    "memory",
    "session_search",
    "delegation",
    "cronjob",
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
if "no_mcp" not in api_server_toolsets:
    print("platform_toolsets.api_server missing no_mcp", file=sys.stderr)
    sys.exit(1)
bad_toolsets = {
    platform: sorted(set(values) & forbidden_toolsets)
    for platform, values in toolsets.items()
    if set(values) & forbidden_toolsets
}
if bad_toolsets:
    print(f"remote platform toolsets expose sandbox-local tools: {bad_toolsets}", file=sys.stderr)
    sys.exit(1)
PY
  pass "Built Hermes image has no raw secret-shaped .env values or remote local-tool exposure"
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

require_docker
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image not found: ${IMAGE}"

inspect_image_boundary
assert_startup_rejects_env_entry \
  "DEVTEST_API_TOKEN=01234567-89ab-cdef-0123-456789abcdef" \
  "DEVTEST_API_TOKEN" \
  "01234567-89ab-cdef-0123-456789abcdef"
assert_startup_rejects_env_entry \
  "OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE" \
  "OPENAI_API_KEY" \
  "sk-OPENSHELL-PROXY-REWRITE"

pass "Hermes sandbox secret-boundary smoke passed"
