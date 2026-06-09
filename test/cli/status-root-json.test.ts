// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithEnv } from "./helpers";

describe("CLI root status JSON", () => {
  it("status --json emits parseable structured status without credentials", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-json-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const sandboxName = `alpha-${process.pid}-${Date.now()}`;
    const serviceDir = path.join("/tmp", `nemoclaw-services-${sandboxName}`);
    fs.rmSync(serviceDir, { recursive: true, force: true });
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          [sandboxName]: {
            name: sandboxName,
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["npm"],
            agent: "openclaw",
            dashboardPort: 18789,
            messagingChannels: ["slack"],
            dashboardUrl: "http://127.0.0.1:18789/?token=dashboard-secret",
            logs: "Bearer should-not-render xoxb-should-not-render-000000",
          },
        },
        defaultSandbox: sandboxName,
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const r = runWithEnv("status --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out.trim().startsWith("{")).toBe(true);
      expect(r.out.trim().endsWith("}")).toBe(true);
      expect(r.out).not.toContain("Sandboxes:");
      expect(r.out).not.toContain("(stopped)");

      const parsed = JSON.parse(r.out);
      expect(parsed).toMatchObject({
        schemaVersion: 1,
        defaultSandbox: sandboxName,
        liveInference: {
          provider: "nvidia-prod",
          model: "nvidia/nemotron",
        },
        gatewayHealth: {
          healthy: true,
          state: "healthy_named",
        },
        sandboxes: [
          {
            name: sandboxName,
            model: "nvidia/nemotron",
            provider: "nvidia-prod",
            gpuEnabled: true,
            policies: ["npm"],
            agent: "openclaw",
            dashboardPort: 18789,
            isDefault: true,
          },
        ],
        services: [
          {
            name: "cloudflared",
            running: false,
            pid: null,
          },
        ],
      });
      expect(r.out).not.toMatch(
        /Bearer|nvapi-|sk-|xoxb-|xapp-|password|api[-_]?key|dashboard-secret|should-not-render/i,
      );
    } finally {
      fs.rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("status --json reports gateway health and exits 1 when gateway is unhealthy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-json-gateway-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Error: client error (Connect): Connection refused'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.trim().startsWith("{")).toBe(true);
    expect(r.out.trim().endsWith("}")).toBe(true);

    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      liveInference: null,
      gatewayHealth: {
        healthy: false,
        state: "named_unreachable",
        reason: "host port held or container not running",
      },
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          isDefault: true,
        },
      ],
    });
  });
});
