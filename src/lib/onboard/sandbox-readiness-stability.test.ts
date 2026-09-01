// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import {
  readySandboxFrame,
  replaySandboxObservations,
  terminalSandboxFrame,
} from "./__test-helpers__/sandbox-observer-replay";
import { waitForCreatedSandboxReadyWithTrace } from "./sandbox-readiness-tracing";

const NAME = "my-sandbox";
const TARGET = namedOpenShellGateway("nemoclaw");

describe("created sandbox Ready stability", () => {
  it("preserves single-poll Ready acceptance by default", async () => {
    const { observer, listSandboxes, sleep } = replaySandboxObservations(NAME, [
      readySandboxFrame(),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a stale Ready row until compatibility recreation reaches stable Ready", async () => {
    // Exact fallback-run ordering from 28817562371: after a successful
    // supervisor exec, sandbox-list first retained the old container's Ready
    // row, then published the recreated supervisor's Error -> Ready sequence.
    const { observer, listSandboxes, sleep } = replaySandboxObservations(NAME, [
      readySandboxFrame(),
      terminalSandboxFrame("Error"),
      readySandboxFrame(),
      readySandboxFrame(),
    ]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      stableReadyPolls: 2,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2);
  });
});
