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
const REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSIONS = ["2026.4.24", "2026.5.18"] as const;
const CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION = "2026.5.18";

function readRequiredMatch(file: string, pattern: RegExp, description: string): string {
  const match = fs.readFileSync(file, "utf-8").match(pattern);
  if (!match?.[1]) {
    throw new Error(`Expected ${description} in ${path.basename(file)}`);
  }
  return match[1];
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
  fs.writeFileSync(blueprint, 'min_openclaw_version: "2026.4.2"\n');
  fs.mkdirSync(openclawInstall, { recursive: true });
  fs.writeFileSync(openclawShim, "");
  const command = dockerRunCommandBetween(
    "# The minimum required version comes from nemoclaw-blueprint/blueprint.yaml",
    "# Patch OpenClaw media fetch",
  )
    .replaceAll("/opt/nemoclaw-blueprint/blueprint.yaml", blueprint)
    .replaceAll("/usr/local/lib/node_modules/openclaw", openclawInstall)
    .replaceAll("/usr/local/bin/openclaw", openclawShim);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'openclaw ${currentVersion}\\n'; else return 127; fi; }`,
    'npm() { printf "npm %s\\n" "$*" >> "$call_log"; }',
    'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "codex-acp" ]; then return 0; fi; builtin command "$@"; }',
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
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
      'if [ "${1:-}" = "-i" ] && [ "${2:-}" = "-E" ]; then',
      "  expr=$3",
      "  shift 3",
      '  for file in "$@"; do perl -0pi -e "$expr" "$file"; done',
      "  exit 0",
      "fi",
      'exec /usr/bin/sed "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBin;
}

function runFetchGuardPatchBlock(dist: string, tmp: string, version = "2026.5.18") {
  const command = dockerRunCommandBetween(
    "# Patch OpenClaw media fetch for proxy-only sandbox",
    "# --- Patch 3: follow symlinks in plugin-install path checks (#2203)",
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
    timeout: 5000,
  });
}

describe("fetch-guard patch regression guard", () => {
  it("fails the image build when the NemoClaw OpenClaw plugin cannot install", () => {
    const command = dockerRunCommandBetween(
      "# Install NemoClaw plugin into OpenClaw",
      "# SECURITY: Clear any gateway auth token",
    );
    expect(command).toContain("openclaw plugins install /opt/nemoclaw");
    expect(command).toContain("openclaw plugins enable nemoclaw");
    expect(command).toContain("openclaw plugins inspect nemoclaw --json");
    expect(command).not.toContain("--dangerously-force-unsafe-install");
    expect(command).not.toMatch(/openclaw plugins install \/opt\/nemoclaw[^&|]*(?:\|\|\s*true|2>&1)/);

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

  it("upgrades stale OpenClaw from the blueprint minimum and leaves current installs alone", () => {
    const stale = runOpenClawUpgradeBlock("2026.3.11");
    expect(stale.result.status).toBe(0);
    expect(stale.result.stdout).toContain("upgrading to 2026.4.2");
    expect(stale.calls).toContain(
      "npm install -g --no-audit --no-fund --no-progress openclaw@2026.4.2",
    );

    const current = runOpenClawUpgradeBlock("2026.4.2");
    expect(current.result.status).toBe(0);
    expect(current.result.stdout).toContain("is current (>= 2026.4.2)");
    expect(current.calls).not.toContain("openclaw@2026.4.2");
  });

  it("requires classifier review when the pinned OpenClaw build version changes", () => {
    const reviewMessage =
      "Update fetch-guard classifier expectations before changing the OpenClaw build version.";

    const blueprintMinVersion = readBlueprintMinOpenClawVersion();
    const baseImageVersion = readDockerfileBaseOpenClawVersion();

    expect(baseImageVersion, "Dockerfile.base and blueprint must pin the same OpenClaw version.").toBe(
      blueprintMinVersion,
    );
    expect([...REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSIONS], reviewMessage).toContain(
      blueprintMinVersion,
    );
  });

  it("rewrites strict media fetch exports and makes proxy validation sandbox-aware", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const modulePath = path.join(dist, "fetch-guard-test.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "globalThis.proxyChecks = [];",
        "async function assertExplicitProxyAllowed(proxyUrl) { globalThis.proxyChecks.push(proxyUrl); throw new Error('proxy rejected'); }",
        "globalThis.assertExplicitProxyAllowed = assertExplicitProxyAllowed;",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
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
      expect(patch.stdout).toContain("Patch 1 applied");
      expect(patch.stdout).toContain("Patch 2 applied");
      const verify = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const exports = await import(${JSON.stringify(modulePath)});
if (exports.a !== exports.b) throw new Error('strict export was not redirected to trusted env proxy mode');
await globalThis.assertExplicitProxyAllowed('http://10.200.0.1:3128');
if (globalThis.proxyChecks.length !== 0) throw new Error('sandbox proxy validation did not bypass target-policy checks');`,
        ],
        { encoding: "utf-8", env: { ...process.env, OPENSHELL_SANDBOX: "1" }, timeout: 5000 },
      );
      expect(verify.status).toBe(0);
      expect(verify.stderr).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the Dockerfile OpenClaw source-shape patches aligned with current dist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-patches-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "fetch-guard-test.js"),
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "async function assertExplicitProxyAllowed(proxyUrl) { throw new Error(proxyUrl); }",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dist, "install-safe-path-test.js"),
      "const baseLstat = await fs.lstat(baseDir);\n",
    );
    fs.writeFileSync(
      path.join(dist, "install-package-dir-test.js"),
      [
        "async function assertInstallBaseStable(params) {",
        "  const baseLstat = await fs.lstat(params.installBaseDir);",
        "  if (baseLstat.isSymbolicLink()) throw new Error('symlink');",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dist, "client-test.js"),
      "const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;\n",
    );
    fs.writeFileSync(
      path.join(dist, "server.impl-test.js"),
      "const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;\n",
    );

    const command = dockerRunCommandBetween(
      "# Patch OpenClaw media fetch for proxy-only sandbox",
      "# Patch OpenClaw chat.send gateway behavior",
    ).replaceAll("/usr/local/lib/node_modules/openclaw/dist", dist);
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    const sedWrapper = path.join(fakeBin, "sed");
    fs.writeFileSync(
      sedWrapper,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "extended=0",
        'if [ "${1:-}" = "-i" ]; then',
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
    const scriptPath = path.join(tmp, "patch-all.sh");
    fs.writeFileSync(scriptPath, ["#!/usr/bin/env bash", command].join("\n"), { mode: 0o700 });

    try {
      const patch = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
        timeout: 5000,
      });
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      const patched = fs
        .readdirSync(dist)
        .map((file) => fs.readFileSync(path.join(dist, file), "utf-8"));
      expect(patched.join("\n")).not.toContain("DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3");
      expect(patched.join("\n")).not.toContain("DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 1e4");
      expect(patched.join("\n").match(/DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 6e4/g)).toHaveLength(
        2,
      );
      expect(fs.readFileSync(path.join(dist, "install-safe-path-test.js"), "utf-8")).toContain(
        "const baseLstat = await fs.stat(baseDir)",
      );
      expect(fs.readFileSync(path.join(dist, "install-package-dir-test.js"), "utf-8")).toContain(
        "const baseLstat = await fs.stat(params.installBaseDir)",
      );
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
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.18");
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
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.18");
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
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.18");
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
      const patch = runFetchGuardPatchBlock(dist, tmp, "2026.5.18");
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("Patch 2 applied");
      const patched = fs.readFileSync(modulePath, "utf-8");
      expect(patched).toContain("nemoclaw: env-gated bypass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
