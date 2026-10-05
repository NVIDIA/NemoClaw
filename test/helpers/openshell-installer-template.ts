// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MACOS_METHOD_START = `MACOS_INSTALL_METHOD="\${_NEMOCLAW_OPENSHELL_INSTALL_METHOD:-auto}"`;
const MACOS_METHOD_END = "esac\n";

export function installerReleaseTemplate(source: string, version: string): string {
  const v012Comment =
    "  # OpenShell 0.1.2 enforces MCP policy in its supervisor image. Recognize\n" +
    "  # only its exact pinned sandbox artifacts here, not version text alone.\n" +
    "  # Runtime policy verification still precedes credential/provider changes.\n";
  if (version !== "0.1.2" && source.includes(v012Comment)) {
    const fallback =
      "    local sandbox_digest\n" +
      '    sandbox_digest="$(file_sha256 "$sandbox_bin")" || return 1\n' +
      '    if [ "$(pinned_sandbox_build_version "$sandbox_digest")" = "0.1.2" ]; then\n' +
      "      return 0\n" +
      "    fi\n";
    assert.ok(source.includes(fallback), "OpenShell 0.1.2 sandbox fixture fallback");
    source = source
      .replace(
        v012Comment,
        "  # MCP policy enforcement and credential replacement execute in\n" +
          "  # openshell-sandbox. When that host artifact is present, require the native\n" +
          "  # MCP policy marker from that exact binary.\n",
      )
      .replace(fallback, "");
  }
  if (version === "0.0.106" || version === "0.0.116" || version === "0.1.2") return source;
  const start = source.indexOf(MACOS_METHOD_START);
  const end = source.indexOf(MACOS_METHOD_END, start);
  if (start === -1 || end === -1 || source.indexOf(MACOS_METHOD_START, start + 1) !== -1) {
    throw new Error("Expected one macOS install-method binding");
  }
  return `${source.slice(0, start)}${source.slice(end + MACOS_METHOD_END.length)}`.replaceAll(
    "test/install/",
    "test/",
  );
}

export function addV00106OperationalTrust(source: string): string {
  const withIdentityCheck = source.replace(
    "pinned_sandbox_build_version() {",
    `is_pinned_openshell_v00106_linux_x86_64_install() {
  local openshell_bin="$1"
  local gateway_bin="$2"
  local sandbox_bin="$3"
  local openshell_sha gateway_sha sandbox_sha

  [ "$OS" = "Linux" ] && [ "$ARCH_LABEL" = "x86_64" ] || return 1
  openshell_sha="$(file_sha256 "$openshell_bin")" || return 1
  gateway_sha="$(file_sha256 "$gateway_bin")" || return 1
  sandbox_sha="$(file_sha256 "$sandbox_bin")" || return 1
  [ "$openshell_sha" = "98ecf95113fea999e94a928043e57b04cf58a45a1b66ae8bffc73d1bc8bb1d59" ] \\
    && [ "$gateway_sha" = "e6cde8a54568aa1926ff6584ffd6984314c68dad64d2722509618a74094c622c" ] \\
    && [ "$sandbox_sha" = "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8" ]
}

pinned_sandbox_build_version() {`,
  );
  const capabilityMarker = "  # OpenShell #1865 has no authoritative CLI/RPC capability query yet.";
  const result = withIdentityCheck.replace(
    capabilityMarker,
    `  # The v0.0.106 release binaries are stripped and no longer retain every
  # source-level capability marker used by the development-build fallback
  # below. Accept only the reviewed executable byte identities as the stable
  # release capability proof; arbitrary binaries that merely report 0.0.106
  # must still pass the fail-closed marker checks.
  if is_pinned_openshell_v00106_linux_x86_64_install \\
    "$openshell_bin" "$gateway_bin" "$sandbox_bin"; then
    return 0
  fi

${capabilityMarker}`,
  );
  assert.notEqual(withIdentityCheck, source, "v0.0.106 executable identity helper");
  assert.notEqual(result, withIdentityCheck, "v0.0.106 capability proof");
  return result;
}

export function removeV00106OperationalTrust(source: string): string {
  const identityStart = source.indexOf("is_pinned_openshell_v00106_linux_x86_64_install() {");
  const sandboxStart = source.indexOf("pinned_sandbox_build_version() {", identityStart);
  assert.ok(![identityStart, sandboxStart].includes(-1), "v0.0.106 helper boundaries");
  const withoutIdentity = `${source.slice(0, identityStart)}${source.slice(sandboxStart)}`;
  const capabilityStart = withoutIdentity.indexOf(
    "  # The v0.0.106 release binaries are stripped and no longer retain every",
  );
  const fallbackStart = withoutIdentity.indexOf(
    "  # OpenShell #1865 has no authoritative CLI/RPC capability query yet.",
    capabilityStart,
  );
  assert.ok(![capabilityStart, fallbackStart].includes(-1), "v0.0.106 proof boundaries");
  return `${withoutIdentity.slice(0, capabilityStart)}${withoutIdentity.slice(fallbackStart)}`;
}

export function prepareReleaseFixtureRuntime(repoRoot: string, root: string): void {
  const runtimePath = "src/lib/onboard/docker-driver-gateway-runtime.ts";
  const candidatePins = fs.readFileSync(path.join(root, runtimePath), "utf8");
  const source = fs.readFileSync(path.join(repoRoot, runtimePath), "utf8");
  const prepared = source.replace(
    /const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = \{[\s\S]*?\n\};/,
    candidatePins.trim(),
  );
  fs.writeFileSync(path.join(root, runtimePath), prepared);
}

export function extractPreparedRelease(repoRoot: string, root: string, format = "json") {
  return spawnSync(
    "node",
    [
      "--no-warnings",
      path.join(repoRoot, "scripts/checks/extract-installer-pins.mts"),
      "--blueprint",
      path.join(root, "nemoclaw-blueprint/blueprint.yaml"),
      "--installer",
      path.join(root, "scripts/install-openshell.sh"),
      "--brev-installer",
      path.join(root, "scripts/brev-launchable-ci-cpu.sh"),
      "--supervisor-runtime",
      path.join(root, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
      "--format",
      format,
    ],
    { encoding: "utf8" },
  );
}
