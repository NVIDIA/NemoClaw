// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const START_SCRIPT = path.join(repoRoot, "agents", "langchain-deepagents-code", "start.sh");
const ENTRYPOINT_ENV_WRAPPER = path.join(repoRoot, "scripts", "lib", "entrypoint-env-wrapper.sh");

export type ManagedScriptOptions = {
  installRlimitHelper?: (rlimitLib: string) => void;
  caFile?: string;
};

export type StartScriptFixtureOptions = ManagedScriptOptions & {
  envDir?: string;
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

export function prepareManagedScriptFixture(
  source: string,
  tempDir: string,
  options: ManagedScriptOptions = {},
): string {
  const installRlimitHelper = options.installRlimitHelper ?? writeRlimitStub;
  const rlimitLib = path.join(tempDir, "sandbox-rlimits.sh");
  const caFile = options.caFile ?? path.join(tempDir, "trusted-ca-bundle.pem");
  if (options.caFile === undefined) writeReadOnlyFile(caFile, "trusted CA bundle\n");
  installRlimitHelper(rlimitLib);
  return source
    .replace("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", ENTRYPOINT_ENV_WRAPPER)
    .replace("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
    .replace("../../scripts/lib/sandbox-rlimits.sh", "missing-dev-sandbox-rlimits.sh")
    .replace(
      'readonly MANAGED_FETCH_CA_BUNDLE_FILE="/run/openshell-supervisor-ca/material/ca-bundle.crt"',
      `readonly MANAGED_FETCH_CA_BUNDLE_FILE="${caFile}"`,
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
  const original = fs.readFileSync(START_SCRIPT, "utf8");
  assert.ok(original.includes("local target=/tmp/nemoclaw-proxy-env.sh"));
  assert.ok(original.includes('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"'));
  assert.ok(original.includes("local marker_dir=/sandbox/.deepagents"));
  fs.mkdirSync(envDir, { recursive: true });
  const envRedirected = prepareManagedScriptFixture(original, tempDir, options)
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
