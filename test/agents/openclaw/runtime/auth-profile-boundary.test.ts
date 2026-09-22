// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);
const WRAPPER = [
  "set -euo pipefail",
  `eval "$(sed -n '/^write_auth_profile() {$/,/^}$/p' "$1")"`,
  `eval "$(sed -n '/^clear_managed_inference_credentials() {$/,/^}$/p' "$1")"`,
  "write_auth_profile",
  "clear_managed_inference_credentials",
  'bash -c \'printf "NVIDIA_INFERENCE_API_KEY=%s\\\\nNVIDIA_API_KEY=%s\\\\n" "${NVIDIA_INFERENCE_API_KEY-unset}" "${NVIDIA_API_KEY-unset}"\'',
].join("\n");

type AuthFixture = {
  home: string;
  authPath: string;
  status: number;
  stdout: string;
  stderr: string;
};

function runWriteAuthProfile(
  env: Record<string, string>,
  prepare: (authPath: string) => void = () => undefined,
): AuthFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-test-"));
  const authPath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  prepare(authPath);
  const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
    input: WRAPPER,
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: "utf-8",
  });
  return {
    home,
    authPath,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function seedAuthProfile(profile: Record<string, unknown>): (authPath: string) => void {
  return (authPath) => {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify(profile));
  };
}

const legacyManagedProfile = {
  type: "api_key",
  provider: "inference",
  keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
  profileId: "inference:manual",
};

describe("write_auth_profile (#1332)", () => {
  it("writes profile under the route identifier from NEMOCLAW_INFERENCE_PROVIDER_ID", () => {
    const fixture = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    });
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"))).toEqual({
        "openai:manual": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
          profileId: "openai:manual",
        },
      });
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("falls back to 'inference' when neither route identifier is set", () => {
    const fixture = runWriteAuthProfile({ NVIDIA_INFERENCE_API_KEY: "secret" });
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"));
      expect(profile).toHaveProperty("inference:manual");
      expect(profile["inference:manual"].provider).toBe("inference");
      expect(profile).not.toHaveProperty("nvidia:manual");
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("does not use 'nvidia' as the default provider key", () => {
    const fixture = runWriteAuthProfile({ NVIDIA_INFERENCE_API_KEY: "secret" });
    try {
      expect(fixture.status).toBe(0);
      const profile = JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"));
      expect(Object.keys(profile).every((key) => !/^nvidia:/.test(key))).toBe(true);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("treats provider_key as a literal (no shell command substitution)", () => {
    const fixture = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "$(echo pwned)",
    });
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"));
      expect(profile).toHaveProperty("$(echo pwned):manual");
      expect(profile["$(echo pwned):manual"].provider).toBe("$(echo pwned)");
      expect(profile).not.toHaveProperty("pwned:manual");
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("is a no-op when NVIDIA_INFERENCE_API_KEY is unset", () => {
    const fixture = runWriteAuthProfile({});
    try {
      expect(fixture.status).toBe(0);
      expect(fs.existsSync(fixture.authPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("writes the auth profile with 0600 permissions", () => {
    const fixture = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    });
    try {
      expect(fixture.status).toBe(0);
      expect(fs.statSync(fixture.authPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("does not create an auth profile for the inference.local route", () => {
    const fixture = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    });
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(fs.existsSync(fixture.authPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("removes a stale NemoClaw-generated profile from a proxy-routed sandbox", () => {
    const fixture = runWriteAuthProfile(
      { NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
      seedAuthProfile({ "inference:manual": legacyManagedProfile }),
    );
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(fs.existsSync(fixture.authPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("preserves user-managed profiles while removing the stale managed entry", () => {
    const customProfile = {
      type: "api_key",
      provider: "custom",
      keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
      profileId: "custom:manual",
    };
    const fixture = runWriteAuthProfile(
      { NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
      seedAuthProfile({
        "inference:manual": legacyManagedProfile,
        "custom:manual": customProfile,
      }),
    );
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.authPath, "utf-8"))).toEqual({
        "custom:manual": customProfile,
      });
      expect(fs.statSync(fixture.authPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("preserves a near-match user-managed profile for the managed provider", () => {
    const userManagedProfile = { ...legacyManagedProfile, label: "user-managed" };
    const original = JSON.stringify({ "inference:manual": userManagedProfile });
    const fixture = runWriteAuthProfile(
      { NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
      (authPath) => {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, original);
      },
    );
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(fs.readFileSync(fixture.authPath, "utf-8")).toBe(original);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("clears both managed credential aliases before a child process starts", () => {
    const fixture = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "primary-secret",
      NVIDIA_API_KEY: "legacy-secret",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
    });
    try {
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(fixture.stdout).toContain("NVIDIA_INFERENCE_API_KEY=unset");
      expect(fixture.stdout).toContain("NVIDIA_API_KEY=unset");
      expect(fixture.stdout).not.toContain("primary-secret");
      expect(fixture.stdout).not.toContain("legacy-secret");
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked auth-profile parent without changing its target", () => {
    const externalContents = JSON.stringify({ "inference:manual": legacyManagedProfile });
    let externalProfile = "";
    const fixture = runWriteAuthProfile(
      { NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
      (authPath) => {
        const openclawDir = path.resolve(authPath, "../../../../");
        const externalAgents = path.join(
          path.resolve(authPath, "../../../../../"),
          "external-agents",
        );
        externalProfile = path.join(externalAgents, "main", "agent", "auth-profiles.json");
        fs.mkdirSync(path.dirname(externalProfile), { recursive: true });
        fs.writeFileSync(externalProfile, externalContents);
        fs.mkdirSync(openclawDir, { recursive: true });
        fs.symlinkSync(externalAgents, path.join(openclawDir, "agents"));
      },
    );
    try {
      expect(fixture.status).not.toBe(0);
      expect(fixture.stderr).toContain("[SECURITY] Refusing auth-profile cleanup");
      expect(fs.readFileSync(externalProfile, "utf-8")).toBe(externalContents);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });
});
