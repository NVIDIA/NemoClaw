// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  MANAGED_STARTUP_E2E_HTTP_PROXY,
  MANAGED_STARTUP_E2E_HTTPS_PROXY,
  MANAGED_STARTUP_E2E_NO_PROXY,
} from "../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  decodeManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
} from "../../src/lib/onboard/managed-startup/profile";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../..",
  "scripts",
  "checks",
  "generate-managed-startup-profile-fixture.mts",
);
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const CHANGED_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const CORPORATE_CA_SHA256 = createHash("sha256")
  .update(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)
  .digest("hex");

function runFixture(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", SCRIPT_PATH, ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("generate-managed-startup-profile-fixture.mts CLI", () => {
  it("emits the exact corporate CA as base64", () => {
    const result = runFixture(["--corporate-ca-b64"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.from(result.stdout.trim(), "base64").toString("utf8")).toBe(
      MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
    );
  });

  it.each([
    {
      name: "missing --agent",
      args: [] as const,
      error: "--agent is required",
    },
    {
      name: "invalid agent",
      args: ["--agent", "not-a-shipped-agent"] as const,
      error: "--agent must identify a shipped managed-image agent",
    },
    {
      name: "unsupported argument",
      args: ["--agent", "openclaw", "--unsupported"] as const,
      error: "unsupported arguments: --unsupported",
    },
  ])("rejects $name", ({ args, error }) => {
    const result = runFixture(args);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(error);
  });

  it.each(MANAGED_STARTUP_AGENTS)("emits a valid default profile for %s", (agent) => {
    const result = runFixture(["--agent", agent]);
    const profile = decodeManagedStartupProfile(result.stdout.trim());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(profile.agent).toBe(agent);
    expect(profile.inference.model).toBe(DEFAULT_MODEL);
    expect(profile.proxy.hostHttpUrl).toBe(MANAGED_STARTUP_E2E_HTTP_PROXY);
    expect(profile.proxy.hostHttpsUrl).toBe(MANAGED_STARTUP_E2E_HTTPS_PROXY);
    expect(profile.proxy.hostNoProxy).toEqual([...MANAGED_STARTUP_E2E_NO_PROXY].sort());
    expect(profile.corporateCa.bundleSha256).toBeNull();
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("honors every supported optional flag together for %s", (agent) => {
    const result = runFixture([
      "--agent",
      agent,
      "--changed",
      "--corporate-ca",
      "--without-host-proxy",
    ]);
    const profile = decodeManagedStartupProfile(result.stdout.trim());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(profile.agent).toBe(agent);
    expect(profile.inference.model).toBe(CHANGED_MODEL);
    expect(profile.proxy.hostHttpUrl).toBeNull();
    expect(profile.proxy.hostHttpsUrl).toBeNull();
    expect(profile.proxy.hostNoProxy).toEqual([]);
    expect(profile.corporateCa.bundleSha256).toBe(CORPORATE_CA_SHA256);
  });
});
