// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collectSandboxCreateFailureDiagnostics } from "../dist/lib/onboard/sandbox-create-failure.js";

describe("sandbox create failure diagnostics", () => {
  it("preserves gateway failure lines and VM console output before cleanup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(
      homeDir,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway",
    );
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const consolePath = path.join(stateDir, "rootfs-console.log");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(consolePath, "vm console detail\n");
    fs.writeFileSync(
      gatewayLogPath,
      [
        "old unrelated line",
        `2026-05-12T20:30:56Z INFO vm driver: create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `2026-05-12T20:30:56Z INFO vm driver: resolved image ref, preparing rootfs sandbox_id=${sandboxId} state_dir=${stateDir}`,
        `2026-05-12T20:34:28Z INFO vm driver: spawning VM launcher sandbox_id=${sandboxId} console_output=${consolePath}`,
        "[2026-05-12T20:34:29Z ERROR krun] Building the microVM failed: Internal(Vm(VmSetup(VmCreate)))",
        `2026-05-12T20:34:29Z WARN Sandbox failed to become ready sandbox_id=${sandboxId} sandbox_name=my-assistant reason=ProcessExited`,
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      backupPath: "/tmp/pre-upgrade-backup",
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.sandboxId).toBe(sandboxId);
    expect(diagnostics?.copiedConsoleOutput).toBe(
      path.join(diagnostics!.dir, "rootfs-console.log"),
    );
    expect(fs.readFileSync(path.join(diagnostics!.dir, "rootfs-console.log"), "utf-8")).toContain(
      "vm console detail",
    );
    const relevant = fs.readFileSync(
      path.join(diagnostics!.dir, "openshell-gateway-relevant.log"),
      "utf-8",
    );
    expect(relevant).toContain("VmCreate");
    expect(relevant).toContain("sandbox_name=my-assistant");
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "backup_path=/tmp/pre-upgrade-backup",
    );
  });
});
