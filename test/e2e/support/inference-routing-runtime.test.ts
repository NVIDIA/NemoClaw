// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import { runDockerVllmValidation } from "../live/inference-routing-helpers.ts";

const runtimeRows = buildE2eWorkflowPlan(
  { targets: "inference-routing" },
  { gatewayRuntimes: ["docker", "podman"] },
).catalogueMatrices.standard;

function runtimeProvider(runtime: string) {
  return new RuntimeProviderPrerequisite({ command: vi.fn() }, undefined, {
    NEMOCLAW_GATEWAY_RUNTIME: runtime,
    OPENSHELL_PODMAN_SOCKET: "/tmp/selected-podman.sock",
  });
}

describe("inference-routing runtime selection", () => {
  it("keeps the shared inference-routing target selected on Docker and Podman", () => {
    expect(runtimeRows.map((row) => row.runtime_provider)).toEqual(["docker", "podman"]);
    expect(runtimeRows.map((row) => row.id)).toEqual(["inference-routing", "inference-routing"]);
  });

  it.each(runtimeRows)(
    "selects the Docker-only proof for the $runtime_provider execution",
    async ({ runtime_provider }) => {
      const runtime = runtimeProvider(runtime_provider);
      const validate = vi.fn(async () => {});
      const skip = vi.fn(() => {
        throw new Error("skipped");
      });
      const result = await Promise.resolve()
        .then(() => runDockerVllmValidation(runtime, skip, validate))
        .then(
          () => "validated",
          () => "skipped",
        );
      const expected = {
        docker: { result: "validated", validations: 1, skips: 0 },
        podman: { result: "skipped", validations: 0, skips: 1 },
      }[runtime.id];
      expect({
        result,
        validations: validate.mock.calls.length,
        skips: skip.mock.calls.length,
      }).toEqual(expected);
    },
  );

  it("cannot run Podman proof commands or resource setup even if the skip callback returns", () => {
    const validate = vi.fn(async () => {});
    expect(() => runDockerVllmValidation(runtimeProvider("podman"), vi.fn(), validate)).toThrow(
      "requires Docker",
    );
    expect(validate).not.toHaveBeenCalled();
  });

  it("propagates a Docker proof failure without converting it to a skip", async () => {
    const failure = new Error("validation command failed");
    const skip = vi.fn();
    await expect(
      runDockerVllmValidation(runtimeProvider("docker"), skip, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(skip).not.toHaveBeenCalled();
  });

  it("waits for the selected Docker proof before completing", async () => {
    let complete!: () => void;
    let settled = false;
    const pending = runDockerVllmValidation(
      runtimeProvider("docker"),
      vi.fn(),
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete();
    await pending;
    expect(settled).toBe(true);
  });
});
