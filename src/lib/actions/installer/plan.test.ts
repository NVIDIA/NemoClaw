// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildInstallerPlan, normalizeInstallerEnv } from "./plan";

const writableState = {
  exists: (targetPath: string) => targetPath !== "/missing",
  isWritable: () => true,
};

describe("installer plan actions", () => {
  it("builds a deterministic installer plan from env, versions, and npm prefix", () => {
    const plan = buildInstallerPlan({
      defaultVersion: "0.1.0",
      env: {
        NEMOCLAW_INSTALL_REF: "feature/refactor",
        NEMOCLAW_INSTALL_TAG: "v9.9.9",
        NEMOCLAW_PROVIDER: "cloud",
        PATH: "/usr/bin",
      },
      nodeVersion: "v22.16.0",
      npmPrefix: "/tmp/npm-prefix",
      npmTargetState: writableState,
      npmVersion: "10.1.0",
    });

    expect(plan.installRef).toBe("feature/refactor");
    expect(plan.installerVersion).toBe("feature/refactor");
    expect(plan.provider).toMatchObject({ normalized: "build", raw: "cloud", valid: true });
    expect(plan.runtime).toEqual({ ok: true, nodeVersion: "v22.16.0", npmVersion: "10.1.0" });
    expect(plan.npm?.globalBin).toBe(path.join("/tmp/npm-prefix", "bin"));
    expect(plan.npm?.pathWithGlobalBin).toBe(`${path.join("/tmp/npm-prefix", "bin")}${path.delimiter}/usr/bin`);
    expect(plan.npm?.linkTargetsWritable?.ok).toBe(true);
  });

  it("marks unsupported providers and missing optional probes without failing plan construction", () => {
    const plan = buildInstallerPlan({ env: { NEMOCLAW_PROVIDER: "bad-provider" } });

    expect(plan.installRef).toBe("latest");
    expect(plan.provider).toMatchObject({ normalized: null, raw: "bad-provider", valid: false });
    expect(plan.runtime).toBeNull();
    expect(plan.npm).toBeNull();
  });

  it("normalizes installer env for shell-compatible helper output", () => {
    expect(normalizeInstallerEnv({ NEMOCLAW_INSTALL_TAG: "v1.2.3", NEMOCLAW_PROVIDER: "nim" })).toEqual({
      installRef: "v1.2.3",
      provider: expect.objectContaining({ normalized: "nim-local", raw: "nim", valid: true }),
    });
  });
});
