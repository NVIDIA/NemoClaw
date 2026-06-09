// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("CLI sandbox status text output", () => {
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

    fs.writeFileSync(path.join(localBin, "docker"), ["#!/usr/bin/env bash", "exit 1"].join("\n"), {
      mode: 0o755,
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

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(
      r.out.startsWith("Failure layer: docker_unreachable — Docker daemon is not reachable."),
    ).toBe(true);
    expect(r.out).not.toContain("Inference: healthy");
    const headerIdx = r.out.indexOf("Failure layer: docker_unreachable");
    const sandboxIdx = r.out.indexOf("Sandbox: alpha");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sandboxIdx).toBeGreaterThan(headerIdx);
    expect((r.out.match(/Failure layer: docker_unreachable/g) || []).length).toBe(1);
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

    fs.writeFileSync(path.join(localBin, "docker"), ["#!/usr/bin/env bash", "exit 1"].join("\n"), {
      mode: 0o755,
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

  // #4495: a paused Docker-driver container can surface upstream as
  // `Phase: Error` even though the sandbox is intact. NemoClaw must keep the
  // raw OpenShell phase but add an actionable paused-container recovery hint.
  it(
    "status surfaces a paused Docker-driver container hint without rewriting Phase: Error",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-paused-"));
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
          '    case "$a" in',
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
    },
  );
});
