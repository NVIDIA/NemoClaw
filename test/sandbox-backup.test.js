// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildBackupArchiveScript,
  buildGatewayStartScript,
  buildGatewayStopScript,
  buildRestoreArchiveScript,
} from "../bin/lib/sandbox-backup.js";

describe("sandbox-backup restore", () => {
  it("renames uploaded archives to the remote restore path before extraction", () => {
    const script = buildRestoreArchiveScript("/tmp/backups/pre-upgrade/sandbox.tar.gz");

    expect(script).toContain("mv '/tmp/sandbox.tar.gz' '/tmp/nemoclaw-sandbox-backup.tar.gz'");
    expect(script).toContain("--exclude='sandbox/.openclaw'");
    expect(script).toContain("--exclude='sandbox/.nemoclaw/blueprints'");
    expect(script).toContain("tar xzf '/tmp/nemoclaw-sandbox-backup.tar.gz'");
    expect(script).toContain("-C /");
  });

  it("builds backup archive script with ignore-failed-read", () => {
    const script = buildBackupArchiveScript();

    expect(script).toContain(
      "tar czf '/tmp/nemoclaw-sandbox-backup.tar.gz' --ignore-failed-read -C / sandbox",
    );
  });

  it("builds a stop script that waits for the gateway to exit", () => {
    const script = buildGatewayStopScript();

    expect(script).toContain("pidof -s openclaw");
    expect(script).toContain('kill "$pid"');
    expect(script).toContain("Timed out waiting for the OpenClaw gateway to stop.");
  });

  it("builds a start script that relaunches the sandbox entrypoint", () => {
    const script = buildGatewayStartScript();

    expect(script).toContain(
      "nohup '/usr/local/bin/nemoclaw-start' >/tmp/gateway.log 2>&1 </dev/null &",
    );
    expect(script).toContain("Timed out waiting for the OpenClaw gateway to start.");
  });
});
