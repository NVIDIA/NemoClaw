// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import {
  createHermesPortableLifecycleTestReceipt,
  createHermesPortableLifecycleTestDeps,
  SANDBOX,
  GATEWAY,
  GENERATION,
  CONTAINER_ID,
  IMAGE,
  SANDBOX_ID,
  LABELS,
} from "./hermes-portable-lifecycle.test-fixture";

/** Model the 0.1.2 companion independently of the workload's stop state. */
export function createHermesPortablePairFixture(
  stateDir: string,
  policyPath: string,
  initiallyRunning: boolean,
) {
  const labels = { ...LABELS, "openshell.ai/isolation-role": "sandbox" };
  const receipt = createHermesPortableLifecycleTestReceipt({
    agent: loadAgent("hermes"),
    stateDir,
    policyPath,
    homeDir: "/home/test",
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    containerId: CONTAINER_ID,
    imageDigest: IMAGE,
    sandboxId: SANDBOX_ID,
    labels,
  });
  const fixture = createHermesPortableLifecycleTestDeps(stateDir, receipt, initiallyRunning, {
    labels,
  });
  const capture = fixture.podman.getMockImplementation()!;
  const supervisorId = "c".repeat(64);
  const supervisor = {
    Id: supervisorId,
    Image: IMAGE,
    Name: `openshell-supervisor-${SANDBOX_ID}`,
    Config: { Labels: { ...LABELS, "openshell.ai/isolation-role": "supervisor" } },
    State: { Running: true, Paused: false, Status: "running" },
    HostConfig: { RestartPolicy: { Name: "no" } },
  };
  fixture.podman.mockImplementation((args) => {
    if (args[0] === "ps") return { status: 0, stdout: supervisorId, stderr: "" };
    if (args[1] === "inspect" && args[2] === supervisorId) {
      return { status: 0, stdout: JSON.stringify([supervisor]), stderr: "" };
    }
    return capture(args);
  });
  return {
    ...fixture,
    supervisor,
    failStartupAndSetSupervisorStopState(supervisorRemainsRunning: boolean) {
      const captureOpenShell = fixture.captureOpenShell.getMockImplementation()!;
      fixture.captureOpenShell.mockImplementation((args) => {
        if (args.includes("python3")) {
          return { status: 0, stdout: "unavailable\n", stderr: "" };
        }
        if (args[0] === "sandbox" && args[1] === "stop") {
          supervisor.State.Running = supervisorRemainsRunning;
          supervisor.State.Status = supervisorRemainsRunning ? "running" : "exited";
        }
        return captureOpenShell(args);
      });
    },
    exitSupervisorAfter(milliseconds: number) {
      const sleep = fixture.deps.sleep.getMockImplementation()!;
      fixture.deps.sleep.mockImplementation((elapsed) => {
        sleep(elapsed);
        if (fixture.deps.now() >= milliseconds) {
          supervisor.State.Running = false;
          supervisor.State.Status = "exited";
        }
      });
    },
  };
}
