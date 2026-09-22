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
  "write_auth_profile",
].join("\n");

type AuthFixture = {
  home: string;
  authPath: string;
  status: number;
  stderr: string;
};

function runWriteAuthProfile(
  env: Record<string, string>,
  prepare: (authPath: string) => void = () => undefined,
): AuthFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-boundary-test-"));
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

describe("managed inference auth-profile boundary", () => {
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
      keyRef: { source: "file", id: "/sandbox/custom-key" },
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

  it("rejects a symlinked auth-profile parent without changing its target", () => {
    const externalContents = JSON.stringify({ "inference:manual": legacyManagedProfile });
    let externalProfile = "";
    const fixture = runWriteAuthProfile(
      { NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
      (authPath) => {
        const openclawDir = path.resolve(authPath, "../../../../");
        const externalAgents = path.join(fixtureRoot(authPath), "external-agents");
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

function fixtureRoot(authPath: string): string {
  return path.resolve(authPath, "../../../../../");
}
