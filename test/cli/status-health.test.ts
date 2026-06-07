// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  run,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI dispatch", () => {
  it("status --help exits 0 and shows status usage", () => {
    const r = run("status --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("status [--json]");
    expect(r.out).toContain("Show sandbox list and service status");
  });

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
            providerCredentialHashes: {
              OPENAI_API_KEY: "sk-should-not-render-000000000000",
            },
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
        /Bearer|nvapi-|sk-|xoxb-|xapp-|password|api[-_]?key|providerCredentialHashes|dashboard-secret|should-not-render/i,
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

  it("sandbox <name> status surfaces docker_unreachable header and suppresses stale Inference probe", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-docker-unreachable-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });

    fs.writeFileSync(
      path.join(localBin, "docker"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
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

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.startsWith(
      "Failure layer: docker_unreachable — Docker daemon is not reachable.",
    )).toBe(true);
    expect(r.out).not.toContain("Inference: healthy");
    const headerIdx = r.out.indexOf("Failure layer: docker_unreachable");
    const sandboxIdx = r.out.indexOf("Sandbox: alpha");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sandboxIdx).toBeGreaterThan(headerIdx);
    expect(
      (r.out.match(/Failure layer: docker_unreachable/g) || []).length,
    ).toBe(1);
  });

  it("sandbox <name> status preserves Inference probe and exits 0 when openshellDriver is not docker", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-non-docker-driver-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "vm",
    });

    fs.writeFileSync(
      path.join(localBin, "docker"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
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

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Failure layer: docker_unreachable");
    expect(r.out).toContain("Sandbox: alpha");
    expect(r.out).toContain("Provider: openai-api");
    expect(r.out).toContain("Model:    gpt-4o-mini");
    expect(r.out).toContain("Inference: healthy");
  });

  it("sandbox <name> status surfaces sandbox_container_stopped when the per-sandbox container exists but is not running", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-container-stopped-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });

    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
        'if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-alpha-7616dcb1"; exit 0; fi',
        'if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo '  Name: alpha'",
        "  echo '  Phase: Error'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
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

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(
      r.out.startsWith(
        "Failure layer: sandbox_container_stopped — sandbox container exists but is not running.",
      ),
    ).toBe(true);
    expect(r.out).not.toContain("Inference: healthy");
    expect(r.out).toContain("Phase: Error");
    expect(r.out).not.toContain("Failure layer: docker_unreachable");
    expect(r.out).not.toContain("Failure layer: sandbox_dashboard_port_conflict");
    const headerIdx = r.out.indexOf("Failure layer: sandbox_container_stopped");
    const sandboxIdx = r.out.indexOf("Sandbox: alpha");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sandboxIdx).toBeGreaterThan(headerIdx);
    // The downstream gateway-state fallback header (`Failure layer: ...`)
    // must be suppressed once preflight has already emitted its own.
    // Otherwise a non-`present` gateway lookup would print a redundant
    // second `Failure layer:` line later in the output.
    expect((r.out.match(/Failure layer:/g) || []).length).toBe(1);
  });

  it("sandbox <name> status surfaces sandbox_dashboard_port_conflict when the sandbox container is stopped and the dashboard port is held by a foreign listener", async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-port-conflict-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("failed to bind foreign listener on a free port");
    }
    const dashboardPort = address.port;

    try {
      writeSandboxRegistry(home, "alpha", {
        provider: "openai-api",
        model: "gpt-4o-mini",
        openshellDriver: "docker",
        dashboardPort,
      });

      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
          'if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-alpha-7616dcb1"; exit 0; fi',
          'if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo '  Name: alpha'",
          "  echo '  Phase: Error'",
          "  exit 0",
          "fi",
          'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
          "  echo 'Gateway inference:'",
          "  echo '  Provider: openai-api'",
          "  echo '  Model: gpt-4o-mini'",
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

      const r = runWithEnv("alpha status", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(1);
      expect(
        r.out.startsWith(
          "Failure layer: sandbox_dashboard_port_conflict — sandbox container is stopped and the dashboard port is held by a foreign listener.",
        ),
      ).toBe(true);
      expect(r.out).not.toContain("Inference: healthy");
      expect(r.out).toContain("Phase: Error");
      expect(r.out).not.toContain("Failure layer: sandbox_container_stopped —");
      const headerIdx = r.out.indexOf("Failure layer: sandbox_dashboard_port_conflict");
      const sandboxIdx = r.out.indexOf("Sandbox: alpha");
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(sandboxIdx).toBeGreaterThan(headerIdx);
      // Downstream gateway-state fallback must not print a second
      // `Failure layer:` line when preflight already emitted one.
      expect((r.out.match(/Failure layer:/g) || []).length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sandbox status --json emits structured per-sandbox report", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-"),
    );
    const localBin = path.join(home, "bin");
    const sandboxName = `alpha-${process.pid}-${Date.now()}`;
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, sandboxName, {
      model: "configured-model",
      provider: "configured-provider",
      gpuEnabled: true,
      policies: ["npm"],
      hostGpuDetected: true,
      sandboxGpuEnabled: true,
      sandboxGpuMode: "passthrough",
      sandboxGpuDevice: "0",
      openshellDriver: "docker",
      openshellVersion: "0.0.44",
    });
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
        `if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-cluster-nemoclaw"; echo "openshell-${sandboxName}-7616dcb1"; exit 0; fi`,
        `if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; echo "openshell-${sandboxName}-7616dcb1"; exit 0; fi`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
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

    const r = runWithEnv(`${sandboxName} status --json`, {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.trim().startsWith("{")).toBe(true);
    expect(r.out.trim().endsWith("}")).toBe(true);
    expect(r.out).not.toContain("Sandbox: ");
    expect(r.out).not.toContain("Nonexistent flag: --json");

    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      name: sandboxName,
      found: true,
      model: "nvidia/nemotron",
      provider: "nvidia-prod",
      hostGpuDetected: true,
      sandboxGpuEnabled: true,
      sandboxGpuMode: "passthrough",
      sandboxGpuDevice: "0",
      openshellDriver: "docker",
      openshellVersion: "0.0.44",
      policies: ["npm"],
      rpcIssue: null,
    });
    expect(typeof parsed.openshellDriver).toBe("string");
    expect(typeof parsed.openshellVersion).toBe("string");
    expect(parsed).toHaveProperty("phase");
    expect(parsed).toHaveProperty("inferenceHealth");
    expect(parsed).toHaveProperty("gatewayState");
  });

  // #4495: a paused Docker-driver container can surface upstream as
  // `Phase: Error` even though the sandbox is intact. NemoClaw must keep the
  // raw OpenShell phase but add an actionable paused-container recovery hint.
  it("status surfaces a paused Docker-driver container hint without rewriting Phase: Error", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-status-paused-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      openshellDriver: "docker",
      openshellVersion: "0.0.44",
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Error'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
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
    // Docker reports the resolved sandbox container as paused.
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "ps" ]; then echo "openshell-alpha-abc123"; exit 0; fi',
        'if [ "$1" = "inspect" ]; then',
        '  for a in "$@"; do',
        "    case \"$a\" in",
        '      *Paused*) echo "true"; exit 0 ;;',
        '      *Health*) echo "none"; exit 0 ;;',
        "    esac",
        "  done",
        '  echo ""; exit 0',
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      30000,
    );

    // Raw OpenShell phase is preserved verbatim — not rewritten to Ready.
    expect(r.out).toContain("Phase: Error");
    // Actionable paused-container recovery hint is added.
    expect(r.out).toContain("paused: openshell-alpha-abc123");
    expect(r.out).toContain("docker unpause openshell-alpha-abc123");
    // The misleading rebuild suggestion must not fire for a paused container.
    expect(r.out).not.toContain("rebuild --yes");

    // The structured report exposes the paused flag for automation consumers.
    const j = runWithEnv(
      "alpha status --json",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      30000,
    );
    const parsed = JSON.parse(j.out);
    expect(parsed.phase).toBe("Error");
    expect(parsed.dockerPaused).toBe(true);
  });

  it("sandbox status --json defaults openshell driver/version to 'unknown' strings", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-unknown-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    const parsed = JSON.parse(r.out);
    expect(r.code).toBe(0);
    expect(parsed.openshellDriver).toBe("unknown");
    expect(parsed.openshellVersion).toBe("unknown");
    expect(typeof parsed.openshellDriver).toBe("string");
    expect(typeof parsed.openshellVersion).toBe("string");
  });

  it("sandbox status --json surfaces rpcIssue and exits 1 on protobuf mismatch", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-rpc-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'protobuf decode: invalid wire type'",
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

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.rpcIssue).toEqual({ kind: "protobuf_mismatch" });
    expect(parsed.inferenceHealth).toBeNull();
    expect(parsed.model).toBe("unknown");
    expect(parsed.provider).toBe("unknown");
  });

  it("sandbox status --json reports found:false and exits 1 for unknown sandbox via canonical form", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-notfound-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    // Registry contains "alpha"; we will query a different name so the
    // canonical `sandbox status <name> --json` path produces the documented
    // automation contract: `found: false`, gatewayState != present, exit 1.
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
        "  echo 'NotFound: sandbox not found'",
        "  exit 1",
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

    const r = runWithEnv("sandbox status ghost --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.name).toBe("ghost");
    expect(parsed.found).toBe(false);
    expect(parsed.gatewayState).not.toBe("present");
    expect(parsed.rpcIssue).toBeNull();
    expect(parsed.model).toBe("unknown");
    expect(parsed.provider).toBe("unknown");
    expect(parsed.openshellDriver).toBe("unknown");
    expect(parsed.openshellVersion).toBe("unknown");
  });

  it("sandbox status --json reports gatewayState!=present and exits 1 when sandbox is registered but gateway lookup is missing", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-nonpresent-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      model: "configured-model",
      provider: "configured-provider",
    });
    // openshell `sandbox get alpha` returns NotFound -> gatewayState becomes
    // "missing" after reconciliation against a healthy named gateway.
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
        "  echo 'NotFound: sandbox not found'",
        "  exit 1",
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

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.name).toBe("alpha");
    expect(parsed.found).toBe(true);
    expect(parsed.gatewayState).not.toBe("present");
    expect(parsed.rpcIssue).toBeNull();
    // Live inference probe is not attempted when gateway is not present, so
    // the report falls back to registry model/provider rather than "unknown".
    expect(parsed.model).toBe("configured-model");
    expect(parsed.provider).toBe("configured-provider");
    expect(parsed.inferenceHealth).toBeNull();
  });

  it("sandbox status --json sets failureLayer=docker_unreachable, suppresses inferenceHealth, and exits 1 when the host Docker daemon is unreachable", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-docker-unreachable-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });

    fs.writeFileSync(
      path.join(localBin, "docker"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
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

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.failureLayer).toBe("docker_unreachable");
    expect(parsed.inferenceHealth).toBeNull();
    expect(parsed.name).toBe("alpha");
    expect(parsed.found).toBe(true);
  });

  it("sandbox status --json sets failureLayer=sandbox_container_stopped when the per-sandbox container is stopped", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-container-stopped-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });

    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
        'if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-alpha-7616dcb1"; exit 0; fi',
        'if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo '  Name: alpha'",
        "  echo '  Phase: Error'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
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

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.failureLayer).toBe("sandbox_container_stopped");
    expect(parsed.phase).toBe("Error");
    expect(parsed.inferenceHealth).toBeNull();
  });

  it("sandbox status --json sets failureLayer=sandbox_dashboard_port_conflict when the dashboard port is held by a foreign listener", async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-port-conflict-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("failed to bind foreign listener on a free port");
    }
    const dashboardPort = address.port;

    try {
      writeSandboxRegistry(home, "alpha", {
        provider: "openai-api",
        model: "gpt-4o-mini",
        openshellDriver: "docker",
        dashboardPort,
      });

      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
          'if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-alpha-7616dcb1"; exit 0; fi',
          'if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo '  Name: alpha'",
          "  echo '  Phase: Error'",
          "  exit 0",
          "fi",
          'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
          "  echo 'Gateway inference:'",
          "  echo '  Provider: openai-api'",
          "  echo '  Model: gpt-4o-mini'",
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

      const r = runWithEnv("alpha status --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(1);
      const parsed = JSON.parse(r.out);
      expect(parsed.failureLayer).toBe("sandbox_dashboard_port_conflict");
      expect(parsed.phase).toBe("Error");
      expect(parsed.inferenceHealth).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sandbox status --json sets failureLayer=null when no preflight failure applies", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-failure-layer-null-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "vm",
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
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

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    const parsed = JSON.parse(r.out);
    expect(parsed.failureLayer).toBeNull();
  });

  it("sandbox status --help advertises --json flag", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-help-json-"),
    );
    writeSandboxRegistry(home);
    const r = runWithEnv("sandbox status alpha --help", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("--json");
    expect(r.out).toContain("$ nemoclaw sandbox status <name> [--json]");
    expect(r.out).toContain("$ nemoclaw sandbox status alpha --json");

    const alias = runWithEnv("alpha status --help", { HOME: home });
    expect(alias.code).toBe(0);
    expect(alias.out).toContain("--json");
  });

  it("status rejects unknown flags through current dispatch path", () => {
    const r = run("status --bogus");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Nonexistent flag: --bogus");
  });

  it("status rejects unexpected positional arguments through current dispatch path", () => {
    const r = run("status bogus");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Unexpected argument: bogus");
  });

});
