// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("native gateway lifecycle", () => {
  it.each([
    ["OpenClaw", "scripts/nemoclaw-start.sh"],
    ["Hermes", "agents/hermes/start.sh"],
  ])("lets %s exit without NemoClaw respawn or quarantine", (_agent, path) => {
    const entrypoint = source(path);

    expect(entrypoint).not.toContain("gateway_control_init");
    expect(entrypoint).not.toContain("requestGatewaySupervisorAction");
    expect(entrypoint).not.toContain("RESPAWN_TIMES=");
    expect(entrypoint).not.toContain("start_gateway_serving_watchdog()");
    expect(entrypoint).not.toContain("record_hermes_managed_gateway_exit()");
    expect(entrypoint).not.toContain("quarantine_hermes_managed_gateway_relaunch()");
    expect(entrypoint).toContain('wait "$GATEWAY_PID"');
  });

  it.each(["Dockerfile", "agents/hermes/Dockerfile"])(
    "%s does not package a NemoClaw gateway lifecycle controller",
    (dockerfile) => {
      const image = source(dockerfile);
      expect(image).not.toContain("nemoclaw-gateway-control");
      expect(image).not.toContain("managed-gateway-control.py");
      expect(image).not.toContain("gateway-supervisor.sh");
    },
  );
});
