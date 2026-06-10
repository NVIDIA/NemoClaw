#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# VM/Docker privileged-exec routing regression for #4245.
#
# This is a hermetic host-side check: it builds the CLI, writes a fake
# NemoClaw sandbox registry, puts a fake docker binary first in PATH, and
# imports the built privileged-exec helper directly. It verifies VM and
# Docker-driver sandboxes route only through their direct sandbox containers.

set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(cd "${_script_dir}/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-vm-driver-privexec.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="$TMP_DIR/bin"
XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE="$TMP_DIR/docker-ps.txt"
XDG_NEMOCLAW_FAKE_DOCKER_LOG="$TMP_DIR/docker.log"
mkdir -p "$FAKE_BIN"
: >"$XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE"
: >"$XDG_NEMOCLAW_FAKE_DOCKER_LOG"

cat >"$FAKE_BIN/docker" <<'SH'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>"${XDG_NEMOCLAW_FAKE_DOCKER_LOG:?}"
if [ "${1:-}" = "ps" ]; then
  cat "${XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE:?}"
  exit 0
fi
echo "unexpected fake docker invocation: $*" >&2
exit 64
SH
chmod 755 "$FAKE_BIN/docker"

cd "$REPO"
BUILD_LOG="/tmp/nemoclaw-vm-driver-privileged-exec-routing-build.log"
if [ ! -d node_modules/@types/node ]; then
  echo "[vm-driver-privileged-exec-routing] Installing npm dependencies"
  {
    echo "Installing npm dependencies"
    npm ci --ignore-scripts
  } >"$BUILD_LOG" 2>&1
else
  echo "npm dependencies already present" >"$BUILD_LOG"
fi
echo "[vm-driver-privileged-exec-routing] Building CLI"
npm run build:cli >>"$BUILD_LOG" 2>&1

export XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE
export XDG_NEMOCLAW_FAKE_DOCKER_LOG
export HOME="$TMP_DIR/home"
export PATH="$FAKE_BIN:$PATH"
mkdir -p "$HOME/.nemoclaw"

node <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();
const registryPath = path.join(process.env.HOME, ".nemoclaw", "sandboxes.json");
const psFile = process.env.XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE;

function writeRegistry(entries) {
  const sandboxes = {};
  for (const entry of entries) sandboxes[entry.name] = entry;
  fs.writeFileSync(
    registryPath,
    JSON.stringify({ defaultSandbox: entries[0]?.name ?? null, sandboxes }, null, 2),
  );
}

function writeDockerPs(names) {
  fs.writeFileSync(psFile, `${names.join("\n")}\n`);
}

function assertDirect(args, expectedContainer, label) {
  assert.deepEqual(
    args,
    ["exec", "--user", "root", expectedContainer, "stat", "-c", "%a", "/sandbox/.openclaw/openclaw.json"],
    `${label} should route to the direct sandbox container`,
  );
  assert.equal(
    args.includes("openshell-gateway-nemoclaw"),
    false,
    `${label} unexpectedly routed through a non-sandbox gateway container`,
  );
}

writeRegistry([
  { name: "alpha", openshellDriver: "vm" },
  { name: "alpha-child", openshellDriver: "vm" },
  { name: "dockerbox", openshellDriver: "docker" },
  { name: "unknown-driver", openshellDriver: null },
]);

writeDockerPs([
  "openshell-gateway-nemoclaw",
  "openshell-alpha-child",
  "openshell-alpha-child-2026",
  "openshell-alpha-abc123",
  "openshell-dockerbox-987",
  "openshell-unknown-driver",
]);

const helper = require(path.join(repo, "dist", "lib", "sandbox", "privileged-exec.js"));
const cmd = ["stat", "-c", "%a", "/sandbox/.openclaw/openclaw.json"];

assertDirect(
  helper.privilegedSandboxExecArgv("alpha", cmd),
  "openshell-alpha-abc123",
  "VM driver with prefix collision",
);
assertDirect(
  helper.privilegedSandboxExecArgv("alpha-child", cmd),
  "openshell-alpha-child",
  "VM driver with exact container",
);
assertDirect(
  helper.privilegedSandboxExecArgv("dockerbox", cmd),
  "openshell-dockerbox-987",
  "Docker driver",
);
assertDirect(
  helper.privilegedSandboxExecArgv("unknown-driver", cmd),
  "openshell-unknown-driver",
  "registry entry without a recorded driver",
);

writeDockerPs(["openshell-gateway-nemoclaw", "openshell-other"]);
assert.throws(
  () => helper.privilegedSandboxExecArgv("alpha", ["id"]),
  /No running direct OpenShell sandbox container found for 'alpha'.*driver: vm/,
  "missing VM direct container should fail clearly",
);

console.log("PASS: VM and Docker privileged exec routing uses direct sandbox containers");
NODE
