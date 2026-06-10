// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { verifyGatewayContainerRunning } from "./gateway-container-running";

function dockerInspectResult(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

describe("verifyGatewayContainerRunning", () => {
  it("returns running when Docker reports a running gateway container", () => {
    const dockerInspect = vi.fn(() => dockerInspectResult(0, "true\n"));

    expect(verifyGatewayContainerRunning("nemoclaw", { dockerInspect })).toBe("running");
    expect(dockerInspect).toHaveBeenCalledWith(
      ["--type", "container", "--format", "{{.State.Running}}", "openshell-cluster-nemoclaw"],
      { ignoreError: true, suppressOutput: true },
    );
  });

  it("returns stopped for existing but stopped containers (#4187)", () => {
    const dockerInspect = vi.fn(() => dockerInspectResult(0, "false\n"));

    expect(verifyGatewayContainerRunning("nemoclaw", { dockerInspect })).toBe("stopped");
  });

  it("returns missing when Docker reports the gateway container is absent", () => {
    expect(
      verifyGatewayContainerRunning("nemoclaw", {
        dockerInspect: vi.fn(() => dockerInspectResult(1, "", "Error: No such object")),
      }),
    ).toBe("missing");
    expect(
      verifyGatewayContainerRunning("nemoclaw", {
        dockerInspect: vi.fn(() => dockerInspectResult(1, "", "No such container")),
      }),
    ).toBe("missing");
  });

  it("returns unknown for daemon or inspection failures", () => {
    const dockerInspect = vi.fn(() =>
      dockerInspectResult(1, "", "Cannot connect to Docker daemon"),
    );

    expect(verifyGatewayContainerRunning("nemoclaw", { dockerInspect })).toBe("unknown");
  });
});
