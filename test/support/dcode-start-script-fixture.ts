// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const START_SCRIPT = path.join(repoRoot, "agents", "langchain-deepagents-code", "start.sh");
const ENTRYPOINT_ENV_WRAPPER = path.join(repoRoot, "scripts", "lib", "entrypoint-env-wrapper.sh");

export type ManagedProxyEndpoint = { host: string; port: string };

export const DEFAULT_MANAGED_PROXY: ManagedProxyEndpoint = { host: "10.200.0.1", port: "3128" };

export type ManagedProxyScriptOptions = {
  installRlimitHelper?: (rlimitLib: string) => void;
  managedProxy?: ManagedProxyEndpoint;
};

export type StartScriptFixtureOptions = ManagedProxyScriptOptions & {
  envDir?: string;
  fallbackCaFile?: string;
  liveCaFile?: string;
  markerDir?: string;
};

export function dcodeStateDir(tempDir: string): string {
  return path.join(tempDir, "persistent-dcode-state");
}

function writeRlimitStub(rlimitLib: string): void {
  fs.writeFileSync(
    rlimitLib,
    "harden_resource_limits() { :; }\nverify_resource_limits_exact() { :; }\n",
    "utf8",
  );
}

function writeReadOnlyFile(file: string, contents: string): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o444);
}

export function prepareManagedProxyFixture(
  source: string,
  tempDir: string,
  options: ManagedProxyScriptOptions = {},
): string {
  const managedProxy = options.managedProxy ?? DEFAULT_MANAGED_PROXY;
  const installRlimitHelper = options.installRlimitHelper ?? writeRlimitStub;
  const rlimitLib = path.join(tempDir, "sandbox-rlimits.sh");
  const hostFile = path.join(tempDir, "trusted-proxy-host");
  const portFile = path.join(tempDir, "trusted-proxy-port");
  const caFile = path.join(tempDir, "trusted-ca-bundle.pem");
  writeReadOnlyFile(hostFile, `${managedProxy.host}\n`);
  writeReadOnlyFile(portFile, `${managedProxy.port}\n`);
  writeReadOnlyFile(caFile, "trusted CA bundle\n");
  installRlimitHelper(rlimitLib);
  return source
    .replace("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", ENTRYPOINT_ENV_WRAPPER)
    .replace("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
    .replace("../../scripts/lib/sandbox-rlimits.sh", "missing-dev-sandbox-rlimits.sh")
    .replaceAll("/run/nemoclaw/managed-startup-ca-bundle.pem", caFile)
    .replace(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"',
      `readonly MANAGED_PROXY_HOST_FILE="${hostFile}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"',
      `readonly MANAGED_PROXY_PORT_FILE="${portFile}"`,
    )
    .replace(
      'readonly MANAGED_FETCH_CA_BUNDLE_FILE="/etc/openshell-tls/ca-bundle.pem"',
      `readonly MANAGED_FETCH_CA_BUNDLE_FILE="${caFile}"`,
    )
    .replace(
      "readonly MANAGED_PROXY_OWNER_UID=0",
      `readonly MANAGED_PROXY_OWNER_UID=${process.getuid?.() ?? 0}`,
    );
}

export function makeStartScriptFixture(
  tempDir: string,
  options: StartScriptFixtureOptions = {},
): {
  envFile: string;
  scriptPath: string;
} {
  const envDir = options.envDir ?? tempDir;
  const envFile = path.join(envDir, "proxy-env.sh");
  const scriptPath = path.join(tempDir, "start.sh");
  const markerDir = options.markerDir;
  const original = fs
    .readFileSync(START_SCRIPT, "utf8")
    .replaceAll(
      "/etc/openshell-tls/ca-bundle.pem",
      options.liveCaFile ?? "/etc/openshell-tls/ca-bundle.pem",
    )
    .replaceAll(
      "/run/nemoclaw/managed-startup-ca-bundle.pem",
      options.fallbackCaFile ?? "/run/nemoclaw/managed-startup-ca-bundle.pem",
    );
  assert.ok(original.includes("local target=/tmp/nemoclaw-proxy-env.sh"));
  assert.ok(original.includes('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"'));
  assert.ok(original.includes("local marker_dir=/sandbox/.deepagents"));
  const loginProfileVerification = `verify_dcode_login_profile() {
  [ -d /sandbox ] \\
    && [ ! -L /sandbox ] \\
    && [ -f "$NEMOCLAW_DCODE_LOGIN_PROFILE_SOURCE" ] \\
    && [ ! -L "$NEMOCLAW_DCODE_LOGIN_PROFILE_SOURCE" ] \\
    && [ "$(stat -c '%U:%G:%a' "$NEMOCLAW_DCODE_LOGIN_PROFILE_SOURCE" 2>/dev/null || true)" = "root:root:444" ] \\
    && [ ! -L /sandbox/.bash_profile ] \\
    && [ "$(stat -c '%U:%G:%a' /sandbox 2>/dev/null || true)" = "root:sandbox:1775" ] \\
    && [ "$(stat -c '%U:%G:%a' /sandbox/.bash_profile 2>/dev/null || true)" = "root:root:444" ] \\
    && cmp -s "$NEMOCLAW_DCODE_LOGIN_PROFILE_SOURCE" /sandbox/.bash_profile
}`;
  assert.ok(original.includes(loginProfileVerification));
  fs.mkdirSync(envDir, { recursive: true });
  const envRedirected = prepareManagedProxyFixture(original, tempDir, options)
    // These unit fixtures exercise post-drop entrypoint behavior on the host.
    // The dedicated login-profile tests and live image acceptance cover the
    // Linux root-owned file contract, which cannot be reproduced as non-root
    // on every contributor platform.
    .replace(loginProfileVerification, "verify_dcode_login_profile() { return 0; }")
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${envDir}/nemoclaw-proxy-env.XXXXXX")"`,
    );
  const markerRedirected =
    markerDir === undefined
      ? envRedirected
      : envRedirected.replace(
          "local marker_dir=/sandbox/.deepagents",
          `local marker_dir="${markerDir}"`,
        );
  // macOS mv lacks GNU's --no-target-directory flag. Linux CI exercises the
  // production command so a missing -T regression cannot be hidden here.
  const fixture =
    process.platform === "darwin"
      ? markerRedirected.replace('mv -fT -- "$tmp" "$target"', 'mv -f "$tmp" "$target"')
      : markerRedirected;
  assert.ok(fixture.includes(`local target="${envFile}"`));
  assert.ok(fixture.includes(`tmp="$(mktemp "${envDir}/nemoclaw-proxy-env.XXXXXX")"`));
  assert.ok(!fixture.includes("local target=/tmp/nemoclaw-proxy-env.sh"));
  assert.ok(!fixture.includes('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"'));
  fs.writeFileSync(scriptPath, fixture, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, scriptPath };
}
