// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
} from "../../cua/contract";
import type { SandboxEntry } from "../../state/registry";
import { buildCuaTargetDoctorCheck } from "./doctor";
import { getSandboxStatusReport } from "./status";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const attachment: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  target: {
    identityDigest: digest("1"),
    platform: "fixture-linux-amd64",
    image: { name: "fixture-image", version: "1", digest: digest("2"), owner: "fixture" },
    serviceBundle: {
      name: "fixture-services",
      version: "1",
      digest: digest("3"),
      owner: "fixture",
    },
    capabilities: [
      { id: "browser", protocolVersion: "1", health: "healthy" },
      { id: "computer", protocolVersion: "1", health: "healthy" },
      { id: "terminal", protocolVersion: "1", health: "healthy" },
    ],
  },
  activeTask: null,
};

const readiness = { kind: "runtime-readiness" } as CuaRuntimeReadiness;

describe("CUA target status and doctor projection (#7751)", () => {
  it("adds only the secret-free target projection to sandbox status JSON", async () => {
    const sandbox = {
      name: "alpha",
      agent: "openclaw",
      cuaTarget: attachment,
    } as SandboxEntry;

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });

    expect(report.cuaTarget).toEqual(attachment);
    expect(JSON.stringify(report.cuaTarget)).not.toMatch(
      /credential|password|secret|token|endpoint|hostname|ssh|vnc/i,
    );
  });

  it("reports an attached target and its three capability health states", () => {
    const check = buildCuaTargetDoctorCheck("alpha", {
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });

    expect(check).toMatchObject({
      group: "Sandbox",
      label: "CUA target",
      status: "ok",
      detail: expect.stringContaining("browser=healthy"),
    });
    expect(check?.detail).toContain("computer=healthy");
    expect(check?.detail).toContain("terminal=healthy");
    expect(check?.detail).not.toMatch(/endpoint|hostname|credential/i);
  });

  it("fails doctor for replaced target state and reports detached state as informational", () => {
    expect(
      buildCuaTargetDoctorCheck("alpha", {
        name: "alpha",
        cuaRuntimeReadiness: readiness,
        cuaTarget: { ...attachment, status: "replaced" },
      }),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("replaced") });

    expect(
      buildCuaTargetDoctorCheck("alpha", {
        name: "alpha",
        cuaRuntimeReadiness: readiness,
      }),
    ).toMatchObject({ status: "info", detail: "no target attached" });
  });
});
