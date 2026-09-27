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
  NEMOCLAW_INFERENCE_BASE_URL: "hTtPs://InFeReNcE.LoCaL/v1",
};
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const AUTH_FUNCTIONS = [
  "set -euo pipefail",
  extractShellFunctionFromSource(START_SOURCE, "is_managed_inference_route"),
  extractShellFunctionFromSource(START_SOURCE, "write_auth_profile"),
  extractShellFunctionFromSource(START_SOURCE, "clear_managed_inference_credentials"),
].join("\n");

function runBashAuthFixture(
  env: Record<string, string>,
  prepare: (authPath: string) => void = () => undefined,
  commands = `clear_managed_inference_credentials\nwrite_auth_profile\n${credentialProbe}`,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-test-"));
  homes.push(home);
  const authPath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  prepare(authPath);
  const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
    input: `${AUTH_FUNCTIONS}\n${commands}`,
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: "utf-8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  return { authPath, ...result };
}

function seedAuthProfile(profile: Record<string, unknown>): (authPath: string) => void {
  return (authPath) => {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify(profile));
  };
}

function startupSection(startMarker: string, endMarker: string, region: string): string {
  const regionStart = START_SOURCE.indexOf(region);
  const start = START_SOURCE.indexOf(startMarker, regionStart);
  const end = START_SOURCE.indexOf(endMarker, start);
  expect(
    regionStart !== -1 && start !== -1 && end !== -1 && end > start,
    `Expected startup section ${startMarker}`,
  ).toBe(true);
  return START_SOURCE.slice(start, end);
}

function doctorBlock(kind: "non-root" | "root" = "root"): string {
  return startupSection(
    kind === "root" ? "configure_messaging_channels\n" : "  apply_messaging_runtime_env_aliases\n",
    "refresh_openclaw_provider_placeholders\n",
    kind === "root" ? "# ── Root path" : "# ── Non-root fallback",
  );
}

function startupCredentialBoundaryBlock(kind: "non-root" | "root"): string {
  return kind === "root"
    ? `${doctorBlock()}\n${startupSection("# Write direct-route profiles after Doctor", "\nprepare_auto_pair_log", "# ── Root path")}`
    : startupSection(
        "  apply_messaging_runtime_env_aliases\n",
        "\n  configure_messaging_channels",
        "# ── Non-root fallback",
      );
}

function runStartupCredentialBoundary(
  kind: "non-root" | "root",
  route = "managed",
  failCleanup = false,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-startup-"));
  homes.push(home);
  const script = path.join(home, "run.sh");
  const command = path.join(home, "command.sh");
  fs.writeFileSync(command, `#!/usr/bin/env bash\necho command\n${credentialProbe}\n`, {
    mode: 0o700,
  });
  const bootstrap = START_SOURCE.slice(
    START_SOURCE.indexOf("# managed-entrypoint-env-wrapper end"),
    START_SOURCE.indexOf("# Reject an invalid explicit dashboard port"),
  );
  const wrapper = [
    START_SOURCE.match(/^set -[a-z]+ pipefail$/m)?.[0] ?? "",
    ...[
      "is_managed_inference_route",
      "clear_managed_inference_credentials",
      "_step_down_extract_function",
      "run_step_down_as_sandbox",
      "setup_auth_profile_as_sandbox",
      "run_oneshot_command",
    ].map((name) => extractShellFunctionFromSource(START_SOURCE, name)),
    'NEMOCLAW_CMD=("$AUTH_TEST_COMMAND")',
    '_RUNTIME_SHELL_ENV_FILE="$HOME/no-runtime-env"',
    "STEP_DOWN_PREFIX_SANDBOX=(env)",
    "apply_messaging_runtime_env_aliases() { :; }",
    "openclaw_config_dir_owner() { echo sandbox; }",
    `write_auth_profile() { ${credentialProbe}; return ${failCleanup ? 41 : 0}; }`,
    "harden_auth_profiles() { :; }",
    "install_messaging_runtime_preloads() { :; }",
    "verify_messaging_runtime_secret_scans() { :; }",
    "normalize_mutable_config_perms() { :; }",
    "configure_messaging_channels() { :; }",
    "run_requested_openclaw_post_upgrade_doctor() { :; }",
    bootstrap,
    credentialProbe,
    startupCredentialBoundaryBlock(kind),
  ].join("\n");
  fs.writeFileSync(script, wrapper);
  return spawnSync("bash", [script], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      AUTH_TEST_COMMAND: command,
      ...managedEnv,
      ...(route === "direct" ? { NEMOCLAW_INFERENCE_BASE_URL: "https://direct.example/v1" } : {}),
    },
    encoding: "utf-8",
  });
}

function legacyProfile(provider = "inference", keyId = "NVIDIA_INFERENCE_API_KEY") {
  return {
    type: "api_key",
    provider,
    keyRef: { source: "env", id: keyId },
    profileId: `${provider}:manual`,
  };
}
const legacyManagedProfile = legacyProfile();

describe("OpenClaw auth-profile boundary", () => {
  it.each([
    ["default", undefined, "inference"],
    ["configured", "openai", "openai"],
    ["literal", "$(echo pwned)", "$(echo pwned)"],
  ] as const)("writes a private direct profile for the %s route", (_label, route, provider) => {
    const fixture = runBashAuthFixture({
      NVIDIA_INFERENCE_API_KEY: "secret",
      ...(route === undefined ? {} : { NEMOCLAW_INFERENCE_PROVIDER_ID: route }),
    });
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"))).toEqual({
      [`${provider}:manual`]: legacyProfile(provider),
    });
    expect(fs.statSync(fixture.authPath).mode & 0o777).toBe(0o600);
  });

  it("leaves direct auth state absent when no credential is supplied", () => {
    const fixture = runBashAuthFixture({});
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(fs.existsSync(fixture.authPath)).toBe(false);
  });

  it.each([
    ["fresh", "https://inference.local/v1"],
    ["legacy", "https://inference.local/v1"],
    ["fresh", "HTTPS://inference.local:443/v1"],
    ["legacy", "https://INFERENCE.LOCAL:443"],
  ] as const)(
    "leaves no managed profile or inherited credentials in %s state at %s",
    (state, baseUrl) => {
      const fixture = runBashAuthFixture(
        { ...(state === "fresh" ? managedEnv : {}), NEMOCLAW_INFERENCE_BASE_URL: baseUrl },
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
    const customProfile = legacyProfile("custom");
    const fixture = runBashAuthFixture(
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
    const fixture = runBashAuthFixture(managedEnv, seedAuthProfile(profiles));
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(fs.readFileSync(fixture.authPath, "utf-8")).toBe(JSON.stringify(profiles));
  });

  // This component fixture observes the profiles passed to Doctor.
  it.each([
    ["root", "managed"],
    ["root", "direct"],
    ["non-root", "managed"],
    ["non-root", "direct"],
  ] as const)("presents configured %s %s profiles to Doctor", (kind, route) => {
    const custom = legacyProfile("custom", "CUSTOM_API_KEY");
    const profiles = { "openai:manual": legacyProfile("openai"), "custom:manual": custom };
    const fixture = runBashAuthFixture(
      {
        ...managedEnv,
        NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
        ...(route === "direct" ? { NEMOCLAW_INFERENCE_BASE_URL: "https://direct.example/v1" } : {}),
      },
      seedAuthProfile(profiles),
      [
        extractShellFunctionFromSource(START_SOURCE, "setup_auth_profile_as_sandbox"),
        // Keep fixture HOME instead of switching users; reconciliation remains real.
        "run_step_down_as_sandbox() { write_auth_profile; }",
        "NEMOCLAW_CMD=()",
        "apply_messaging_runtime_env_aliases() { :; }",
        "harden_auth_profiles() { :; }",
        "configure_messaging_channels() { :; }",
        `run_requested_openclaw_post_upgrade_doctor() { ${credentialProbe} >&2; cat "$HOME/.openclaw/agents/main/agent/auth-profiles.json"; }`,
        "clear_managed_inference_credentials",
        doctorBlock(kind),
      ].join("\n"),
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(JSON.parse(fixture.stdout)).toEqual(
      route === "managed" ? { "custom:manual": custom } : profiles,
    );
    expect(fixture.stderr.trim()).toBe(
      route === "managed" ? "unset\nunset" : "primary-secret\nlegacy-secret",
    );
  });

  it.each([
    ["non-root", "managed", true],
    ["root", "managed", true],
    ["non-root", "direct", false],
    ["root", "direct", true],
  ] as const)(
    "passes only allowed credentials to setup and command children in %s startup for %s routes",
    (kind, route, writesProfile) => {
      const result = runStartupCredentialBoundary(kind, route);
      const credentials = route === "managed" ? "unset\nunset" : "primary-secret\nlegacy-secret";
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        [credentials, ...(writesProfile ? [credentials] : []), "command", credentials].join("\n"),
      );
    },
  );

  it.each(["non-root", "root"] as const)(
    "stops %s startup when auth-profile reconciliation fails",
    (kind) => {
      const result = runStartupCredentialBoundary(kind, "managed", true);
      expect(result.status, result.stderr).toBe(41);
      expect(result.stdout).not.toContain("command");
    },
  );

  it("rejects a FIFO profile without waiting for a writer", () => {
    const fixture = runBashAuthFixture(
      managedEnv,
      (authPath) => {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        expect(spawnSync("mkfifo", [authPath]).status).toBe(0);
      },
      'python3() { exec python3 "$@"; }; write_auth_profile',
    );
    expect(fixture.error).toBeUndefined();
    expect(fixture.status).toBe(1);
    expect(fixture.stderr).toContain("auth-profiles.json is not a regular file");
  });

  it("rejects a symlinked parent without changing its target", () => {
    const externalContents = JSON.stringify({ "inference:manual": legacyManagedProfile });
    let externalProfile = "";
    const fixture = runBashAuthFixture(managedEnv, (authPath) => {
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
