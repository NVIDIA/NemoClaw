// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");
const DOCKERFILE_BASE = path.join(import.meta.dirname, "..", "Dockerfile.base");
const BLUEPRINT = path.join(import.meta.dirname, "..", "nemoclaw-blueprint", "blueprint.yaml");
const REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSIONS = [
  "2026.4.24",
  "2026.5.18",
  "2026.5.22",
  "2026.5.27",
] as const;
const CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION = "2026.5.27";
const EXPECTED_OPENCLAW_INTEGRITY =
  "sha512-2N93zhdAo88KAbHt6T7KvYXf4s7XIkYXBgv1npYpn7e1Y9FvrtgtpsA38my9rtFW+70uXEojRPX5/OqnuDqJPw==";
const REVIEWED_OPENCLAW_2026_5_27_WEB_FETCH_SHAPE = [
  "async function fetchWithWebToolsNetworkGuard(params) {",
  "  const { timeoutSeconds, useEnvProxy, ...rest } = params;",
  "  const resolved = {",
  "    ...rest,",
  "    timeoutMs: resolveTimeoutMs({",
  "      timeoutMs: rest.timeoutMs,",
  "      timeoutSeconds",
  "    })",
  "  };",
  "  return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));",
  "}",
].join("\n");
const REVIEWED_OPENCLAW_2026_5_27_MANAGED_PROXY_SHAPE =
  "const canUseManagedProxy = mode === GUARDED_FETCH_MODE.STRICT && isManagedProxyActive() && hasProxyEnvConfigured();";
const REVIEWED_OPENCLAW_2026_5_27_SSRF_POLICY_SHAPE = [
  "function shouldSkipPrivateNetworkChecks(hostname, policy) {",
  "  return isPrivateNetworkAllowedByPolicy(policy) || normalizeHostnameSet(policy?.allowedHostnames).has(hostname);",
  "}",
  "function resolveHostnamePolicyChecks(hostname, policy) {",
  "  const normalized = normalizeHostname(hostname);",
  '  if (!normalized) throw new Error("Invalid hostname");',
  "  const hostnameAllowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);",
  "  const skipPrivateNetworkChecks = shouldSkipPrivateNetworkChecks(normalized, policy);",
  "  if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);",
  "  if (!skipPrivateNetworkChecks) assertAllowedHostOrIpOrThrow(normalized, policy);",
  "  return {",
  "    normalized,",
  "    skipPrivateNetworkChecks",
  "  };",
  "}",
].join("\n");

function loadReviewedOpenClaw20260527SsrfPolicyShape() {
  return new Function(`
class SsrFBlockedError extends Error {}
function normalizeHostname(value) {
  return String(value || "").toLowerCase().replace(/\\.+$/, "");
}
function normalizeHostnameSet(values) {
  if (!values || values.length === 0) return new Set();
  return new Set(values.map((value) => normalizeHostname(value)).filter(Boolean));
}
function normalizeHostnameAllowlist(values) {
  if (!values || values.length === 0) return [];
  return Array.from(new Set(values.map((value) => normalizeHostname(value)).filter((value) => value !== "*" && value !== "*." && value.length > 0)));
}
function isPrivateNetworkAllowedByPolicy(policy) {
  return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}
function matchesHostnameAllowlist(hostname, allowlist) {
  return allowlist.length === 0 || allowlist.includes(hostname);
}
function assertAllowedHostOrIpOrThrow(hostnameOrIp) {
  if (hostnameOrIp === "host.openshell.internal" || hostnameOrIp.endsWith(".internal") || hostnameOrIp === "10.0.0.1") {
    throw new SsrFBlockedError("blocked " + hostnameOrIp);
  }
}
${REVIEWED_OPENCLAW_2026_5_27_SSRF_POLICY_SHAPE}
return { shouldSkipPrivateNetworkChecks, resolveHostnamePolicyChecks };
  `)() as {
    shouldSkipPrivateNetworkChecks: (hostname: string, policy?: Record<string, unknown>) => boolean;
    resolveHostnamePolicyChecks: (
      hostname: string,
      policy?: Record<string, unknown>,
    ) => { normalized: string; skipPrivateNetworkChecks: boolean };
  };
}

function readRequiredMatch(file: string, pattern: RegExp, description: string): string {
  const match = fs.readFileSync(file, "utf-8").match(pattern);
  if (!match?.[1]) {
    throw new Error(`Expected ${description} in ${path.basename(file)}`);
  }
  return match[1];
}

function compareDotVersions(left: string, right: string): number {
  const lhs = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rhs = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] ?? 0;
    const b = rhs[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function expectVersionAtLeast(actual: string, minimum: string, message: string) {
  expect(compareDotVersions(actual, minimum), message).toBeGreaterThanOrEqual(0);
}

function readBlueprintMinOpenClawVersion(): string {
  return readRequiredMatch(BLUEPRINT, /min_openclaw_version:\s*"([^"]+)"/, "OpenClaw minimum");
}

function readDockerfileBaseOpenClawVersion(): string {
  return readRequiredMatch(
    DOCKERFILE_BASE,
    /^ARG OPENCLAW_VERSION=([^\s]+)/m,
    "OpenClaw base image version",
  );
}

function readDockerfileOpenClawVersion(): string {
  return readRequiredMatch(
    DOCKERFILE,
    /^ARG OPENCLAW_VERSION=([^\s]+)/m,
    "OpenClaw runtime version",
  );
}

function readDockerfileBaseOpenClawIntegrity(): string {
  return readRequiredMatch(
    DOCKERFILE_BASE,
    /^ARG OPENCLAW_2026_5_27_INTEGRITY=([^\s]+)/m,
    "OpenClaw base image integrity",
  );
}

function readDockerfileOpenClawIntegrity(): string {
  return readRequiredMatch(
    DOCKERFILE,
    /^ARG OPENCLAW_2026_5_27_INTEGRITY=([^\s]+)/m,
    "OpenClaw runtime integrity",
  );
}

function dockerRunCommandBetween(startMarker: string, endMarker: string): string {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const command = dockerfile
    .slice(runIndex, end)
    .trim()
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .replace(/\\\s*$/, "");
  return command;
}

function runOpenClawUpgradeBlock(currentVersion: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-upgrade-"));
  const blueprint = path.join(tmp, "blueprint.yaml");
  const log = path.join(tmp, "calls.log");
  const openclawInstall = path.join(tmp, "openclaw-global");
  const openclawShim = path.join(tmp, "openclaw-bin");
  const openclawVersion = readDockerfileOpenClawVersion();
  const openclawIntegrity = readDockerfileOpenClawIntegrity();
  fs.writeFileSync(blueprint, `min_openclaw_version: "${readBlueprintMinOpenClawVersion()}"\n`);
  fs.mkdirSync(openclawInstall, { recursive: true });
  fs.writeFileSync(openclawShim, "");
  const command = dockerRunCommandBetween(
    "# OPENCLAW_VERSION is the NemoClaw runtime build target",
    "# Patch OpenClaw media fetch",
  )
    .replaceAll("/opt/nemoclaw-blueprint/blueprint.yaml", blueprint)
    .replaceAll("/usr/local/lib/node_modules/openclaw", openclawInstall)
    .replaceAll("/usr/local/bin/openclaw", openclawShim);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `OPENCLAW_2026_5_27_INTEGRITY=${JSON.stringify(openclawIntegrity)}`,
    `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'openclaw ${currentVersion}\\n'; else return 127; fi; }`,
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" = "view" ] && [ "${2:-}" = "openclaw@${OPENCLAW_VERSION}" ] && [ "${3:-}" = "dist.integrity" ]; then',
    '    printf "%s\\n" "$OPENCLAW_2026_5_27_INTEGRITY";',
    "  fi",
    "}",
    'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "codex-acp" ]; then return 0; fi; builtin command "$@"; }',
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

function createSedWrapper(tmp: string): string {
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  const sedWrapper = path.join(fakeBin, "sed");
  fs.writeFileSync(
    sedWrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "-i" ]; then',
      "  extended=0",
      '  if [ "${2:-}" = "-E" ]; then',
      "    extended=1",
      "    expr=$3",
      "    shift 3",
      "  else",
      "    expr=$2",
      "    shift 2",
      "  fi",
      '  for file in "$@"; do',
      "    tmp=$(mktemp)",
      '    if [ "$extended" = "1" ]; then',
      '      /usr/bin/sed -E "$expr" "$file" > "$tmp"',
      "    else",
      '      /usr/bin/sed "$expr" "$file" > "$tmp"',
      "    fi",
      '    mv "$tmp" "$file"',
      "  done",
      "  exit 0",
      "fi",
      'exec /usr/bin/sed "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBin;
}

function runDockerfilePatchBlock(
  dist: string,
  tmp: string,
  endMarker: string,
  version = "2026.5.27",
) {
  const command = dockerRunCommandBetween(
    "# Patch OpenClaw media fetch for proxy-only sandbox",
    endMarker,
  ).replaceAll("/usr/local/lib/node_modules/openclaw/dist", dist);
  const scriptPath = path.join(tmp, "patch.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'OpenClaw ${version}\\n'; else return 127; fi; }`,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );
  const fakeBin = createSedWrapper(tmp);
  return spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    timeout: 10000,
  });
}

function runFetchGuardPatchBlock(dist: string, tmp: string, version = "2026.5.27") {
  return runDockerfilePatchBlock(
    dist,
    tmp,
    "# --- Patch 3: follow symlinks in plugin-install path checks (#2203)",
    version,
  );
}

function webGuardedFetchFixtureSource(): string {
  return [
    "const withStrictGuardedFetchMode = (params) => ({ ...params, mode: 'strict' });",
    "const withTrustedEnvProxyGuardedFetchMode = (params) => ({ ...params, mode: 'trusted_env_proxy' });",
    "globalThis.hostnameChecks = [];",
    "function normalizeHostname(value) { return String(value || '').toLowerCase().replace(/\\.+$/, ''); }",
    "function resolveHostnamePolicyChecks(hostname, policy) {",
    "  const normalized = normalizeHostname(hostname);",
    "  globalThis.hostnameChecks.push({ normalized, policy });",
    "  const allowedHostnames = new Set((policy?.allowedHostnames ?? []).map(normalizeHostname));",
    "  if (normalized === 'host.openshell.internal' && allowedHostnames.has(normalized)) return { normalized, skipPrivateNetworkChecks: true };",
    "  if (normalized === 'host.openshell.internal' || normalized.endsWith('.internal') || normalized === '169.254.169.254' || normalized === '10.0.0.1') throw new Error('blocked ' + normalized);",
    "  return { normalized, skipPrivateNetworkChecks: false };",
    "}",
    "function assertHostnameAllowedWithPolicy(hostname, policy) { return resolveHostnamePolicyChecks(hostname, policy).normalized; }",
    "async function resolvePinnedHostnameWithPolicy(hostname, params = {}) { return { hostname: resolveHostnamePolicyChecks(hostname, params.policy).normalized }; }",
    "async function fetchWithSsrFGuard(params) {",
    "  const parsed = new URL(params.url);",
    "  if (params.mode === 'trusted_env_proxy') return { hostname: assertHostnameAllowedWithPolicy(parsed.hostname, params.policy), mode: params.mode, policy: params.policy };",
    "  return { hostname: (await resolvePinnedHostnameWithPolicy(parsed.hostname, { policy: params.policy })).hostname, mode: params.mode, policy: params.policy };",
    "}",
    "async function fetchWithWebToolsNetworkGuard(params) {",
    "  const { timeoutSeconds, useEnvProxy, ...rest } = params;",
    "  const resolved = { ...rest, timeoutMs: rest.timeoutMs ?? timeoutSeconds * 1000 };",
    "  return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));",
    "}",
    "globalThis.assertHostnameAllowedWithPolicy = assertHostnameAllowedWithPolicy;",
    "globalThis.fetchWithWebToolsNetworkGuard = fetchWithWebToolsNetworkGuard;",
    "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b, fetchWithWebToolsNetworkGuard as c };",
    "",
  ].join("\n");
}

describe("fetch-guard patch regression guard", () => {
  it("anchors web_fetch host-gateway policy to the reviewed OpenClaw 2026.5.27 SSRF contract", () => {
    expect(REVIEWED_OPENCLAW_2026_5_27_WEB_FETCH_SHAPE).toContain(
      "function fetchWithWebToolsNetworkGuard(params)",
    );
    expect(REVIEWED_OPENCLAW_2026_5_27_WEB_FETCH_SHAPE).toContain(
      "withTrustedEnvProxyGuardedFetchMode(resolved)",
    );
    expect(REVIEWED_OPENCLAW_2026_5_27_SSRF_POLICY_SHAPE).toContain(
      "normalizeHostnameSet(policy?.allowedHostnames).has(hostname)",
    );
    expect(REVIEWED_OPENCLAW_2026_5_27_SSRF_POLICY_SHAPE).toContain(
      "normalizeHostnameAllowlist(policy?.hostnameAllowlist)",
    );

    const reviewed = loadReviewedOpenClaw20260527SsrfPolicyShape();
    expect(
      reviewed.shouldSkipPrivateNetworkChecks("host.openshell.internal", {
        allowedHostnames: ["HOST.OPENSHELL.INTERNAL."],
      }),
    ).toBe(true);
    expect(
      reviewed.shouldSkipPrivateNetworkChecks("host.openshell.internal", {
        hostnameAllowlist: ["host.openshell.internal"],
      }),
    ).toBe(false);
    expect(
      reviewed.resolveHostnamePolicyChecks("host.openshell.internal", {
        allowedHostnames: ["host.openshell.internal"],
      }),
    ).toEqual({
      normalized: "host.openshell.internal",
      skipPrivateNetworkChecks: true,
    });
    expect(() =>
      reviewed.resolveHostnamePolicyChecks("host.openshell.internal", {
        hostnameAllowlist: ["host.openshell.internal"],
      }),
    ).toThrow(/blocked host\.openshell\.internal/);
  });

  it("fails the image build when the NemoClaw OpenClaw plugin cannot install", () => {
    const command = dockerRunCommandBetween(
      "# Install NemoClaw plugin into OpenClaw",
      "# Apply messaging render and post-agent-install build-file hooks after agent/plugin installation.",
    );
    const script = [
      "openclaw() {",
      '  if [ "${1:-} ${2:-} ${3:-}" = "plugins install /opt/nemoclaw" ]; then return 42; fi',
      "  return 0",
      "}",
      command,
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
    expect(result.status).toBe(42);
  });

  it("upgrades stale OpenClaw to the runtime build target and leaves current installs alone", () => {
    const stale = runOpenClawUpgradeBlock("2026.3.11");
    expect(stale.result.status).toBe(0);
    expect(stale.result.stdout).toContain(
      `upgrading to ${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION}`,
    );
    expect(stale.calls).toContain(
      `npm install -g --no-audit --no-fund --no-progress openclaw@${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION}`,
    );

    const current = runOpenClawUpgradeBlock(CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION);
    expect(current.result.status).toBe(0);
    expect(current.result.stdout).toContain(
      `is current (>= ${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION})`,
    );
    expect(current.calls).not.toContain(
      `npm install -g --no-audit --no-fund --no-progress openclaw@${CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION}`,
    );
  });

  it("requires classifier review and integrity evidence when the OpenClaw build pin changes", () => {
    const reviewMessage =
      "Update fetch-guard classifier expectations before changing the OpenClaw build version.";

    const blueprintMinVersion = readBlueprintMinOpenClawVersion();
    const baseImageVersion = readDockerfileBaseOpenClawVersion();
    const runtimeVersion = readDockerfileOpenClawVersion();

    expectVersionAtLeast(
      baseImageVersion,
      blueprintMinVersion,
      "Dockerfile.base OpenClaw target must satisfy the blueprint minimum.",
    );
    expect(
      runtimeVersion,
      "Dockerfile and Dockerfile.base must build the same OpenClaw target.",
    ).toBe(baseImageVersion);
    expect(readDockerfileBaseOpenClawIntegrity()).toBe(EXPECTED_OPENCLAW_INTEGRITY);
    expect(readDockerfileOpenClawIntegrity()).toBe(EXPECTED_OPENCLAW_INTEGRITY);
    expect([...REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSIONS], reviewMessage).toContain(
      runtimeVersion,
    );
    expect([...REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSIONS], reviewMessage).toContain(
      baseImageVersion,
    );
  });

  it("applies the Dockerfile OpenClaw compatibility patch block to executable fixtures", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-patches-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const symlinkTarget = path.join(tmp, "real-install-base");
    const symlinkBase = path.join(tmp, "install-base-link");
    fs.mkdirSync(symlinkTarget);
    fs.symlinkSync(symlinkTarget, symlinkBase);

    const fetchGuardPath = path.join(dist, "fetch-guard-fixture.js");
    const webGuardPath = path.join(dist, "web-guarded-fetch-fixture.js");
    const installSafePath = path.join(dist, "install-safe-path-fixture.js");
    const installPackageDirPath = path.join(dist, "install-package-dir-fixture.js");
    const clientPath = path.join(dist, "client-fixture.js");
    const serverPath = path.join(dist, "server.impl-fixture.js");

    fs.writeFileSync(
      fetchGuardPath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "globalThis.proxyChecks = [];",
        "globalThis.hostnameChecks = [];",
        "async function assertExplicitProxyAllowed(proxyUrl) { globalThis.proxyChecks.push(proxyUrl); throw new Error('proxy rejected'); }",
        "function normalizeHostname(value) { return String(value || '').toLowerCase().replace(/\\.+$/, ''); }",
        "function resolveHostnamePolicyChecks(hostname, policy) {",
        "  const normalized = normalizeHostname(hostname);",
        "  globalThis.hostnameChecks.push(normalized);",
        "  if (normalized === 'host.openshell.internal' || normalized.endsWith('.internal') || normalized === '169.254.169.254' || normalized === '10.0.0.1') throw new Error('blocked ' + normalized);",
        "  return { normalized, skipPrivateNetworkChecks: false };",
        "}",
        "function assertHostnameAllowedWithPolicy(hostname, policy) { return resolveHostnamePolicyChecks(hostname, policy).normalized; }",
        "globalThis.assertExplicitProxyAllowed = assertExplicitProxyAllowed;",
        "globalThis.assertHostnameAllowedWithPolicy = assertHostnameAllowedWithPolicy;",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(webGuardPath, webGuardedFetchFixtureSource());
    fs.writeFileSync(
      installSafePath,
      [
        'import fs from "node:fs/promises";',
        "export async function acceptsBaseDir(baseDir) {",
        "  const baseLstat = await fs.lstat(baseDir);",
        "  return baseLstat.isDirectory();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      installPackageDirPath,
      [
        'import fs from "node:fs/promises";',
        "export async function assertInstallBaseStable(params) {",
        "  const baseLstat = await fs.lstat(params.installBaseDir);",
        "  if (baseLstat.isSymbolicLink()) throw new Error('symlink');",
        "  if (await fs.realpath(params.installBaseDir) !== params.expectedRealPath) throw new Error('drift');",
        "  return baseLstat.isDirectory();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(clientPath, "export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;\n");
    fs.writeFileSync(serverPath, "export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;\n");

    try {
      const patch = runDockerfilePatchBlock(
        dist,
        tmp,
        "# Patch OpenClaw chat.send gateway behavior",
        CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
      );
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      expect(patch.stdout).toContain("Patch 2b applied");

      const fetchGuard = await import(`${fetchGuardPath}?${Date.now()}`);
      expect(fetchGuard.a).toBe(fetchGuard.b);
      const previousSandboxEnv = process.env.OPENSHELL_SANDBOX;
      process.env.OPENSHELL_SANDBOX = "1";
      try {
        await (globalThis as any).assertExplicitProxyAllowed("http://10.200.0.1:3128");
        await import(`${webGuardPath}?${Date.now()}`);
        const trusted = await (globalThis as any).fetchWithWebToolsNetworkGuard({
          url: "http://host.openshell.internal:8000",
          useEnvProxy: true,
        });
        expect(trusted.hostname).toBe("host.openshell.internal");
        expect(trusted.policy).toEqual({
          allowedHostnames: ["host.openshell.internal"],
        });
        expect(() =>
          (globalThis as any).assertHostnameAllowedWithPolicy("host.openshell.internal"),
        ).toThrow(/blocked host\.openshell\.internal/);
        delete process.env.OPENSHELL_SANDBOX;
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://host.openshell.internal:8000",
            useEnvProxy: true,
          }),
        ).rejects.toThrow(/blocked host\.openshell\.internal/);
        process.env.OPENSHELL_SANDBOX = "1";
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://host.openshell.internal:8000",
            useEnvProxy: false,
          }),
        ).rejects.toThrow(/blocked host\.openshell\.internal/);
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://foo.internal",
            useEnvProxy: true,
          }),
        ).rejects.toThrow(/blocked foo\.internal/);
        await expect(
          (globalThis as any).fetchWithWebToolsNetworkGuard({
            url: "http://169.254.169.254",
            useEnvProxy: true,
          }),
        ).rejects.toThrow(/blocked 169\.254\.169\.254/);
      } finally {
        if (previousSandboxEnv === undefined) {
          delete process.env.OPENSHELL_SANDBOX;
        } else {
          process.env.OPENSHELL_SANDBOX = previousSandboxEnv;
        }
      }
      expect((globalThis as any).proxyChecks).toEqual([]);
      expect((globalThis as any).hostnameChecks).toEqual([
        {
          normalized: "host.openshell.internal",
          policy: { allowedHostnames: ["host.openshell.internal"] },
        },
        { normalized: "host.openshell.internal", policy: undefined },
        { normalized: "host.openshell.internal", policy: undefined },
        { normalized: "host.openshell.internal", policy: undefined },
        { normalized: "foo.internal", policy: undefined },
        { normalized: "169.254.169.254", policy: undefined },
      ]);

      const installSafe = await import(`${installSafePath}?${Date.now()}`);
      await expect(installSafe.acceptsBaseDir(symlinkBase)).resolves.toBe(true);

      const installPackageDir = await import(`${installPackageDirPath}?${Date.now()}`);
      await expect(
        installPackageDir.assertInstallBaseStable({
          installBaseDir: symlinkBase,
          expectedRealPath: fs.realpathSync(symlinkBase),
        }),
      ).resolves.toBe(true);

      const client = await import(`${clientPath}?${Date.now()}`);
      const server = await import(`${serverPath}?${Date.now()}`);
      expect(client.DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS).toBe(60_000);
      expect(server.DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS).toBe(60_000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rewrites strict media fetch exports and makes proxy validation sandbox-aware", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const modulePath = path.join(dist, "fetch-guard-test.js");
    const webGuardPath = path.join(dist, "web-guarded-fetch-test.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "globalThis.proxyChecks = [];",
        "globalThis.hostnameChecks = [];",
        "async function assertExplicitProxyAllowed(proxyUrl) { globalThis.proxyChecks.push(proxyUrl); throw new Error('proxy rejected'); }",
        "function normalizeHostname(value) { return String(value || '').toLowerCase().replace(/\\.+$/, ''); }",
        "function resolveHostnamePolicyChecks(hostname, policy) {",
        "  const normalized = normalizeHostname(hostname);",
        "  globalThis.hostnameChecks.push(normalized);",
        "  if (normalized === 'host.openshell.internal' || normalized.endsWith('.internal') || normalized === '10.0.0.1') throw new Error('blocked ' + normalized);",
        "  return { normalized, skipPrivateNetworkChecks: false };",
        "}",
        "function assertHostnameAllowedWithPolicy(hostname, policy) { return resolveHostnamePolicyChecks(hostname, policy).normalized; }",
        "globalThis.assertExplicitProxyAllowed = assertExplicitProxyAllowed;",
        "globalThis.assertHostnameAllowedWithPolicy = assertHostnameAllowedWithPolicy;",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(webGuardPath, webGuardedFetchFixtureSource());

    try {
      const patch = runFetchGuardPatchBlock(
        dist,
        tmp,
        CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
      );
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      expect(patch.stdout).toContain("Patch 2b applied");
      const verify = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const exports = await import(${JSON.stringify(modulePath)});
const web = await import(${JSON.stringify(webGuardPath)});
if (exports.a !== exports.b) throw new Error('strict export was not redirected to trusted env proxy mode');
await globalThis.assertExplicitProxyAllowed('http://10.200.0.1:3128');
if (globalThis.proxyChecks.length !== 0) throw new Error('sandbox proxy validation did not bypass target-policy checks');
let genericBlocked = false;
try { globalThis.assertHostnameAllowedWithPolicy('host.openshell.internal'); } catch { genericBlocked = true; }
if (!genericBlocked) throw new Error('generic SSRF helper allowed host gateway');
const trusted = await web.c({ url: 'http://host.openshell.internal:8000', useEnvProxy: true });
if (trusted.hostname !== 'host.openshell.internal') throw new Error('host gateway was not allowed through web_fetch trusted proxy');
let strictBlocked = false;
try { await web.c({ url: 'http://host.openshell.internal:8000', useEnvProxy: false }); } catch { strictBlocked = true; }
if (!strictBlocked) throw new Error('strict web_fetch allowed host gateway');
let blocked = false;
try { await web.c({ url: 'http://10.0.0.1', useEnvProxy: true }); } catch { blocked = true; }
if (!blocked) throw new Error('private IP literal was not blocked');`,
        ],
        { encoding: "utf-8", env: { ...process.env, OPENSHELL_SANDBOX: "1" }, timeout: 5000 },
      );
      expect(verify.status).toBe(0);
      expect(verify.stderr).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies the proxy validator patch while the target function still exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-skip-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-fixed.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const mediaDispatcher = {",
        "  allowPrivateProxy: true,",
        "};",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "    ...dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {},",
        "  } : void 0;",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "  return proxyPolicy;",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain(
        "export { withTrustedEnvProxyGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
      );
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the strict export patch when strict fetch mode is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-strict-skip-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-no-strict.js");
    fs.writeFileSync(
      path.join(dist, "media-runtime.js"),
      "export { readRemoteMediaBuffer, saveRemoteMedia, fetchRemoteMedia };\n",
    );
    fs.writeFileSync(
      modulePath,
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 1 not needed");
      expect(patch.stdout).toContain("Patch 2 not needed");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).not.toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the proxy validator patch when pinned hostname checks are not proxy-related", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-target-hostname-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-target-hostname.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse(targetUrl) {",
        "  const parsedTargetUrl = new URL(targetUrl);",
        "  await resolvePinnedHostnameWithPolicy(parsedTargetUrl.hostname, {});",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 not needed");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).not.toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when strict export disappears without a reviewed trusted fetch callsite", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-unreviewed-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-unreviewed.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const withDefaultGuardedFetchMode = Symbol('default');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withDefaultGuardedFetchMode({}));",
        "}",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "    ...dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {},",
        "  } : void 0;",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "  return proxyPolicy;",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dist, "unrelated-trusted-fetch.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchProfile() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 1 target missing but the fetch-guard shape is not a reviewed trusted-proxy-only layout",
      );
      expect(patch.stderr).toContain("Patch 1 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed with actionable details when strict export disappears but strict references remain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-unknown-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const stillUsesStrict = 'withStrictGuardedFetchMode';",
        "async function assertExplicitProxyAllowed(proxyUrl) { return proxyUrl; }",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 1 target missing but the fetch-guard shape is not a reviewed trusted-proxy-only layout",
      );
      expect(patch.stderr).toContain("Patch 1 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the proxy validator target disappears but proxy hostname checks remain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-unknown-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-proxy-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "async function validateExplicitProxy(proxyUrl) {",
        "  const parsedProxyUrl = new URL(proxyUrl);",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {});",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2 target missing but proxy hostname validation references remain",
      );
      expect(patch.stderr).toContain("Patch 2 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the web_fetch trusted-proxy callsite disappears but web fetch refs remain", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-fetch-guard-host-gateway-unknown-"),
    );
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "ssrf-host-gateway-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const webFetchConfig = { useTrustedEnvProxy: true };",
        "async function runWebFetch() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'http://example.com' }));",
        "}",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'http://example.com' }));",
        "}",
        "const toolName = 'web_fetch';",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2b target missing but web_fetch/trusted-proxy references remain",
      );
      expect(patch.stderr).toContain("Patch 2b cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the web_fetch target disappears but the runtime useEnvProxy symbol remains", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-fetch-guard-use-env-proxy-unknown-"),
    );
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "ssrf-host-gateway-use-env-proxy-unknown.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({ url: 'http://example.com' }));",
        "}",
        "async function renamedWebToolsNetworkGuard(params) {",
        "  const { useEnvProxy, ...rest } = params;",
        "  return useEnvProxy ? rest : { ...rest, strict: true };",
        "}",
        "export { renamedWebToolsNetworkGuard as t };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2b target missing but web_fetch/trusted-proxy references remain",
      );
      expect(patch.stderr).toContain("Patch 2b cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when a renamed proxy validator uses an intermediate hostname variable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-renamed-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-proxy-renamed.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "async function validateProxyUrl(proxyUrl) {",
        "  const parsedProxyUrl = new URL(proxyUrl);",
        "  const proxyHostname = parsedProxyUrl.hostname;",
        "  await resolvePinnedHostnameWithPolicy(proxyHostname, {",
        "    policy: { allowPrivateNetwork: true }",
        "  });",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain(
        "Patch 2 target missing but proxy hostname validation references remain",
      );
      expect(patch.stderr).toContain("Patch 2 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not skip the proxy validator patch when only comments match the reviewed shape", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-comments-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-comments.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  // const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "  // hostnameAllowlist: void 0,",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, { policy });",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not skip the proxy validator patch without private proxy allowance", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-private-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-no-private.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "  } : void 0;",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not skip the proxy validator patch for unrelated reviewed-shape code", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-proxy-opt-in-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const modulePath = path.join(dist, "fetch-guard-proxy-unrelated-shape.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const someDispatcher = {",
        "  allowPrivateProxy: true,",
        "};",
        "async function assertExplicitProxyAllowed(dispatcherPolicy, lookupFn, policy) {",
        "  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy",
        "  });",
        "}",
        "function unrelatedReviewedShape(dispatcherPolicy, policy) {",
        "  const proxyPolicy = policy || dispatcherPolicy.allowPrivateProxy === true ? {",
        "    hostnameAllowlist: void 0,",
        "    ...dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {},",
        "  } : void 0;",
        "  return resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {",
        "    policy: proxyPolicy",
        "  });",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.22");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("activates the managed-proxy path for unconfigured strict fetches only inside the sandbox (#4687)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-managed-proxy-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const modulePath = path.join(dist, "fetch-guard-managed-proxy.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "const GUARDED_FETCH_MODE = { STRICT: 'strict' };",
        "function isManagedProxyActive() { return process.env.OPENCLAW_PROXY_ACTIVE === '1'; }",
        "function hasProxyEnvConfigured() { return true; }",
        "function computeCanUseManagedProxy(mode, params) {",
        `  ${REVIEWED_OPENCLAW_2026_5_27_MANAGED_PROXY_SHAPE}`,
        "  return canUseManagedProxy;",
        "}",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b, computeCanUseManagedProxy as g };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(
        dist,
        tmp,
        CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
      );
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 4 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: route unconfigured strict fetch");

      const mod = await import(`${modulePath}?${Date.now()}`);
      const prevSandbox = process.env.OPENSHELL_SANDBOX;
      const prevManaged = process.env.OPENCLAW_PROXY_ACTIVE;
      try {
        // In-sandbox, no explicit dispatcher policy -> reuse the env proxy.
        process.env.OPENSHELL_SANDBOX = "1";
        delete process.env.OPENCLAW_PROXY_ACTIVE;
        expect(mod.g("strict", {})).toBe(true);
        // In-sandbox but an explicit dispatcher policy is supplied -> untouched.
        expect(mod.g("strict", { dispatcherPolicy: { mode: "explicit-proxy" } })).toBe(false);
        // Outside the sandbox -> original strict/direct behavior is preserved.
        delete process.env.OPENSHELL_SANDBOX;
        expect(mod.g("strict", {})).toBe(false);
        // Upstream managed-proxy activation still works regardless of sandbox.
        process.env.OPENCLAW_PROXY_ACTIVE = "1";
        expect(mod.g("strict", {})).toBe(true);
        // Non-strict modes never take the managed-proxy branch.
        process.env.OPENSHELL_SANDBOX = "1";
        delete process.env.OPENCLAW_PROXY_ACTIVE;
        expect(mod.g("trusted_env_proxy", {})).toBe(false);
      } finally {
        if (prevSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
        else process.env.OPENSHELL_SANDBOX = prevSandbox;
        if (prevManaged === undefined) delete process.env.OPENCLAW_PROXY_ACTIVE;
        else process.env.OPENCLAW_PROXY_ACTIVE = prevManaged;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports Patch 4 not needed when the managed-proxy gate is absent", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-fetch-guard-managed-proxy-absent-"),
    );
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-no-managed-proxy.js"),
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 4 not needed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the managed-proxy gate drifts but managed-proxy references remain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-managed-proxy-drift-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-managed-proxy-drift.js"),
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "function isManagedProxyActive() { return process.env.OPENCLAW_PROXY_ACTIVE === '1'; }",
        "function proxyEnvSet() { return true; }",
        // Drifted shape: renamed variables, so the exact reviewed gate is gone.
        "const canUseManagedProxy = currentMode === 'strict' && isManagedProxyActive() && proxyEnvSet();",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );

    try {
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.6.1");
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 4 target missing but managed-proxy references remain");
      expect(patch.stderr).toContain("Patch 4 cannot safely skip");
      expect(patch.stderr).toContain("OpenClaw 2026.6.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function reviewedCronPreflightFixture({
    auditOccurrences = 1,
    includeFetchWithSsrFGuard = true,
    includeBuildLocalProviderSsrFPolicy = true,
    patchedOccurrences = 0,
  }: {
    auditOccurrences?: number;
    includeFetchWithSsrFGuard?: boolean;
    includeBuildLocalProviderSsrFPolicy?: boolean;
    patchedOccurrences?: number;
  } = {}): string {
    const lines: string[] = [
      "const PREFLIGHT_TIMEOUT_MS = 2500;",
      "function buildProbeUrl(api, baseUrl) { return baseUrl + (api === 'ollama' ? '/api/tags' : '/models'); }",
    ];
    const policyHelper = includeBuildLocalProviderSsrFPolicy
      ? "buildLocalProviderSsrFPolicy"
      : "buildDriftedSsrFPolicy";
    if (includeBuildLocalProviderSsrFPolicy) {
      lines.push(
        "function buildLocalProviderSsrFPolicy(baseUrl) {",
        "  const parsed = new URL(baseUrl);",
        "  return { hostnameAllowlist: [parsed.hostname], allowPrivateNetwork: true };",
        "}",
      );
    } else {
      lines.push(
        "function buildDriftedSsrFPolicy(baseUrl) {",
        "  const parsed = new URL(baseUrl);",
        "  return { hostnameAllowlist: [parsed.hostname] };",
        "}",
      );
    }
    lines.push("async function probeLocalProviderEndpoint(params) {");
    for (let index = 0; index < patchedOccurrences; index += 1) {
      lines.push(
        `  const ${index === 0 ? "patched" : `patched_${index}`} = await ${
          includeFetchWithSsrFGuard ? "fetchWithSsrFGuard" : "callPatchedFetch"
        }({`,
        `    url: buildProbeUrl(params.api, params.baseUrl),`,
        `    policy: ${policyHelper}(params.baseUrl),`,
        `    timeoutMs: PREFLIGHT_TIMEOUT_MS,`,
        `    mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight",`,
        "  });",
      );
    }
    for (let index = 0; index < auditOccurrences - patchedOccurrences; index += 1) {
      lines.push(
        `  const ${index === 0 ? "result" : `result_${index}`} = await ${
          includeFetchWithSsrFGuard ? "fetchWithSsrFGuard" : "callUnpatchedFetch"
        }({`,
        `    url: buildProbeUrl(params.api, params.baseUrl),`,
        `    policy: ${policyHelper}(params.baseUrl),`,
        `    timeoutMs: PREFLIGHT_TIMEOUT_MS,`,
        `    auditContext: "cron-model-provider-preflight",`,
        "  });",
      );
    }
    lines.push(
      "  return null;",
      "}",
      "export { probeLocalProviderEndpoint, preflightCronModelProvider };",
      "function preflightCronModelProvider() {}",
      "",
    );
    return lines.join("\n");
  }

  function writeNeighbouringFetchGuardFixtures(dist: string): void {
    // Earlier patches in the same RUN block (1, 2, 2b, 4) only need the dist to
    // navigate their "not needed" branches; mirror the shape proven by the
    // "skips the strict export patch when strict fetch mode is absent" test so
    // execution reaches Patch 6 without classifying the dist as unknown.
    fs.writeFileSync(
      path.join(dist, "media-runtime.js"),
      "export { readRemoteMediaBuffer, saveRemoteMedia, fetchRemoteMedia };\n",
    );
    fs.writeFileSync(
      path.join(dist, "fetch-guard-neighbour.js"),
      [
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function fetchGuardedMediaResponse() {",
        "  return fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode({}));",
        "}",
        "export { withTrustedEnvProxyGuardedFetchMode as a };",
        "",
      ].join("\n"),
    );
  }

  it("applies Patch 6 to a reviewed single-callsite cron preflight fixture", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-happy-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    const preflightPath = path.join(dist, "model-preflight.runtime.js");
    fs.writeFileSync(preflightPath, reviewedCronPreflightFixture());
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain(
        "Patch 6 applied to OpenClaw 2026.5.27 cron preflight trusted env-proxy",
      );
      const patched = fs.readFileSync(preflightPath, "utf-8");
      expect(
        patched.match(/mode: "trusted_env_proxy", auditContext: "cron-model-provider-preflight"/g)
          ?.length,
      ).toBe(1);
      expect(patched).not.toMatch(/(?<!_proxy", )auditContext: "cron-model-provider-preflight"/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats an already-patched cron preflight fixture as a no-op", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-idempotent-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    const preflightPath = path.join(dist, "model-preflight.runtime.js");
    const source = reviewedCronPreflightFixture({ auditOccurrences: 1, patchedOccurrences: 1 });
    fs.writeFileSync(preflightPath, source);
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 6 already present in");
      expect(patch.stdout).not.toContain("Patch 6 applied to OpenClaw");
      expect(fs.readFileSync(preflightPath, "utf-8")).toBe(source);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips Patch 6 when the dist has no cron preflight references", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-absent-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain(
        "OpenClaw 2026.5.27 has no cron model-provider preflight; Patch 6 not needed",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails Patch 6 closed when the fetchWithSsrFGuard helper is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-no-fetch-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    fs.writeFileSync(
      path.join(dist, "model-preflight.runtime.js"),
      reviewedCronPreflightFixture({ includeFetchWithSsrFGuard: false }),
    );
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 6 shape gate: ");
      expect(patch.stderr).toContain("no fetchWithSsrFGuard call");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails Patch 6 closed when the SsrF policy helper is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-no-policy-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    fs.writeFileSync(
      path.join(dist, "model-preflight.runtime.js"),
      reviewedCronPreflightFixture({ includeBuildLocalProviderSsrFPolicy: false }),
    );
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 6 shape gate: ");
      expect(patch.stderr).toContain("no buildLocalProviderSsrFPolicy");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails Patch 6 closed when the audit context literal is ambiguous (multi-callsite)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-patch6-ambiguous-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeNeighbouringFetchGuardFixtures(dist);
    fs.writeFileSync(
      path.join(dist, "model-preflight.runtime.js"),
      reviewedCronPreflightFixture({ auditOccurrences: 2 }),
    );
    try {
      const patch = runFetchGuardPatchBlock(dist, tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("Patch 6 shape gate: ");
      expect(patch.stderr).toContain("refusing ambiguous multi-callsite rewrite");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
