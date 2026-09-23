// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const START_SOURCE = fs.readFileSync(START_SCRIPT, "utf-8");
const credentialProbe =
  'bash -c \'printf "%s\\n" "${NVIDIA_INFERENCE_API_KEY-unset}" "${NVIDIA_API_KEY-unset}"\'';
const managedEnv = {
  NVIDIA_INFERENCE_API_KEY: "primary-secret",
  NVIDIA_API_KEY: "legacy-secret",
  NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
};
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const WRAPPER = [
  "set -euo pipefail",
  extractShellFunctionFromSource(START_SOURCE, "write_auth_profile"),
  extractShellFunctionFromSource(START_SOURCE, "clear_managed_inference_credentials"),
  "write_auth_profile",
  "clear_managed_inference_credentials",
  credentialProbe,
].join("\n");

function runWriteAuthProfile(
  env: Record<string, string>,
  prepare: (authPath: string) => void = () => undefined,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-test-"));
  homes.push(home);
  const authPath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  prepare(authPath);
  const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
    input: WRAPPER,
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: "utf-8",
  });
  return { authPath, ...result };
}

function seedAuthProfile(profile: Record<string, unknown>): (authPath: string) => void {
  return (authPath) => {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify(profile));
  };
}

function startupCredentialBoundaryBlock(kind: "non-root" | "root"): string {
  const regionStart = START_SOURCE.indexOf(
    kind === "non-root"
      ? "# ── Non-root fallback"
      : "# ── Root path (full privilege separation via setpriv)",
  );
  const startMarker =
    kind === "non-root"
      ? "  apply_messaging_runtime_env_aliases\n"
      : "setup_auth_profile_as_sandbox\n";
  const endMarker =
    kind === "non-root" ? "\n  configure_messaging_channels" : "\nprepare_auto_pair_log";
  const start = START_SOURCE.indexOf(startMarker, regionStart);
  const end = START_SOURCE.indexOf(endMarker, start);
  expect(
    regionStart !== -1 && start !== -1 && end !== -1 && end > start,
    `Expected ${kind} credential-boundary block in scripts/nemoclaw-start.sh`,
  ).toBe(true);
  return START_SOURCE.slice(start, end);
}

function runStartupCredentialBoundary(kind: "non-root" | "root") {
  const wrapper = [
    "set -euo pipefail",
    extractShellFunctionFromSource(START_SOURCE, "clear_managed_inference_credentials"),
    "NEMOCLAW_CMD=(probe)",
    "STEP_DOWN_PREFIX_SANDBOX=(env)",
    "apply_messaging_runtime_env_aliases() { :; }",
    "write_auth_profile() { :; }",
    "harden_auth_profiles() { :; }",
    "setup_auth_profile_as_sandbox() { :; }",
    "install_messaging_runtime_preloads() { :; }",
    "verify_messaging_runtime_secret_scans() { :; }",
    `run_oneshot_command() { ${credentialProbe}; }`,
    startupCredentialBoundaryBlock(kind),
  ].join("\n");
  return spawnSync("bash", ["-s", "--", START_SCRIPT], {
    input: wrapper,
    env: { PATH: process.env.PATH, ...managedEnv },
    encoding: "utf-8",
  });
}

const legacyManagedProfile = {
  type: "api_key",
  provider: "inference",
  keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
  profileId: "inference:manual",
};

describe("OpenClaw auth-profile boundary", () => {
  it.each([
    ["default", undefined, "inference"],
    ["configured", "openai", "openai"],
    ["literal", "$(echo pwned)", "$(echo pwned)"],
  ] as const)("writes a private direct profile for the %s route", (_label, route, provider) => {
    const fixture = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      ...(route === undefined ? {} : { NEMOCLAW_INFERENCE_PROVIDER_ID: route }),
    });
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"))).toEqual({
      [`${provider}:manual`]: {
        ...legacyManagedProfile,
        provider,
        profileId: `${provider}:manual`,
      },
    });
    expect(fs.statSync(fixture.authPath).mode & 0o777).toBe(0o600);
  });

  it("leaves direct auth state absent when no credential is supplied", () => {
    const fixture = runWriteAuthProfile({});
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(fs.existsSync(fixture.authPath)).toBe(false);
  });

  it.each(["fresh", "legacy"] as const)(
    "leaves no managed profile or inherited credentials in %s state",
    (state) => {
      const fixture = runWriteAuthProfile(
        state === "fresh"
          ? managedEnv
          : { NEMOCLAW_INFERENCE_BASE_URL: managedEnv.NEMOCLAW_INFERENCE_BASE_URL },
        state === "legacy"
          ? seedAuthProfile({ "inference:manual": legacyManagedProfile })
          : undefined,
      );
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(fs.existsSync(fixture.authPath)).toBe(false);
      expect(fixture.stdout.trim()).toBe("unset\nunset");
    },
  );

  it("preserves other profiles when removing the managed entry", () => {
    const customProfile = {
      ...legacyManagedProfile,
      provider: "custom",
      profileId: "custom:manual",
    };
    const fixture = runWriteAuthProfile(
      managedEnv,
      seedAuthProfile({ "inference:manual": legacyManagedProfile, "custom:manual": customProfile }),
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"))).toEqual({
      "custom:manual": customProfile,
    });
    expect(fs.statSync(fixture.authPath).mode & 0o777).toBe(0o600);
  });

  it("preserves a near-match profile byte for byte", () => {
    const profiles = { "inference:manual": { ...legacyManagedProfile, label: "user-managed" } };
    const fixture = runWriteAuthProfile(managedEnv, seedAuthProfile(profiles));
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(fs.readFileSync(fixture.authPath, "utf-8")).toBe(JSON.stringify(profiles));
  });

  it.each(["non-root", "root"] as const)(
    "clears credential aliases before the %s startup launches a command",
    (kind) => {
      const result = runStartupCredentialBoundary(kind);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("unset\nunset");
    },
  );

  it("rejects a symlinked parent without changing its target", () => {
    const externalContents = JSON.stringify({ "inference:manual": legacyManagedProfile });
    let externalProfile = "";
    const fixture = runWriteAuthProfile(managedEnv, (authPath) => {
      const openclawDir = path.resolve(authPath, "../../../../");
      const externalAgents = path.join(path.dirname(openclawDir), "external-agents");
      externalProfile = path.join(externalAgents, "main", "agent", "auth-profiles.json");
      fs.mkdirSync(path.dirname(externalProfile), { recursive: true });
      fs.writeFileSync(externalProfile, externalContents);
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.symlinkSync(externalAgents, path.join(openclawDir, "agents"));
    });
    expect(fixture.status).not.toBe(0);
    expect(fixture.stderr).toContain("[SECURITY] Refusing auth-profile cleanup");
    expect(fs.readFileSync(externalProfile, "utf-8")).toBe(externalContents);
  });
});
