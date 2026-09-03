// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { ConfigExportInputError, runConfigExport, type ConfigExportDependencies } from "./export";

function dependencies(): ConfigExportDependencies {
  const observation = { sandboxName: "alpha" } as never;
  const config = {
    apiVersion: "nemoclaw.nvidia.com/v1",
    kind: "NemoClawConfig",
    metadata: { name: "team", uid: "123e4567-e89b-42d3-a456-426614174000" },
  } as never;
  return {
    observe: vi.fn(async () => observation),
    buildConfig: vi.fn(() => config),
    render: vi.fn(() => ({
      yaml: "kind: NemoClawConfig\n",
      documentDigest: "doc",
      specDigest: "spec",
    })),
    publish: vi.fn(() => ({ path: "/tmp/alpha.yaml", replaced: false })),
    writeStdout: vi.fn(),
  };
}

describe("runConfigExport", () => {
  it("rejects JSON on YAML stdout before observing the sandbox", async () => {
    const deps = dependencies();
    await expect(
      runConfigExport(
        { sandboxName: "alpha", documentName: "alpha", output: "-", force: false, json: true },
        deps,
      ),
    ).rejects.toThrow(ConfigExportInputError);
    expect(deps.observe).not.toHaveBeenCalled();
  });

  it("writes only canonical YAML to stdout", async () => {
    const deps = dependencies();
    await expect(
      runConfigExport(
        { sandboxName: "alpha", documentName: "alpha", output: "-", force: false, json: false },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.writeStdout).toHaveBeenCalledWith("kind: NemoClawConfig\n");
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("publishes a file and returns the versioned result", async () => {
    const deps = dependencies();
    await expect(
      runConfigExport(
        {
          sandboxName: "alpha",
          documentName: "team",
          output: "/tmp/alpha.yaml",
          force: true,
          json: true,
        },
        deps,
      ),
    ).resolves.toEqual({
      version: 1,
      status: "succeeded",
      sourceSandbox: "alpha",
      outputPath: "/tmp/alpha.yaml",
      documentDigest: "doc",
      specDigest: "spec",
    });
    expect(deps.buildConfig).toHaveBeenCalledWith(expect.anything(), "team");
    expect(deps.publish).toHaveBeenCalledWith("/tmp/alpha.yaml", "kind: NemoClawConfig\n", true);
  });
});
