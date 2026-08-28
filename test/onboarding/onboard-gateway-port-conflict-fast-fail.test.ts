// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGatewayClusterContainerName } from "../../src/lib/adapters/openshell/gateway-drift";
import { resolveGatewayName } from "../../src/lib/onboard/gateway-binding";
import { createProductionGatewayReadinessDependencies } from "../../src/lib/readiness/gateway-production";
import {
  createOnboardProcessWorkspace,
  type OnboardProcessWorkspace,
  runOnboardProcess,
  workspaceEnv,
} from "../helpers/onboard-child-process-harness";
import { testTimeoutOptions } from "../helpers/timeouts";

const CLI = path.join(import.meta.dirname, "../..", "bin", "nemoclaw.js");

describe("onboard gateway port conflict readiness (#6752)", () => {
  let workspace: OnboardProcessWorkspace;
  let gatewayPort: number;
  let gatewayServer: net.Server;

  beforeEach(async () => {
    workspace = createOnboardProcessWorkspace("nemoclaw-6752-");
    gatewayServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      gatewayServer.once("error", reject);
      gatewayServer.listen(0, "127.0.0.1", resolve);
    });
    gatewayPort = (gatewayServer.address() as AddressInfo).port;

    for (const component of ["openshell", "openshell-gateway", "openshell-sandbox"]) {
      workspace.writeExecutable(
        component,
        [
          "#!/usr/bin/env bash",
          "# openshell capabilities: request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods",
          'case "$*" in',
          '  --version|-V) printf "%s 0.0.106\\n" "${0##*/}"; exit 0;;',
          '  status) printf "No active gateway\\n"; exit 1;;',
          '  "gateway info"|"gateway info -g nemoclaw"*) printf "No gateway metadata found\\n"; exit 1;;',
          "esac",
          "exit 1",
        ].join("\n"),
      );
    }

    workspace.writeExecutable("brew", "#!/usr/bin/env bash\nexit 1\n");

    workspace.writeExecutable(
      "docker",
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = info ]; then echo "Server Version: 24.0.0"; exit 0; fi',
        'if [ "$1" = ps ]; then exit 0; fi',
        "exit 0",
      ].join("\n"),
    );

    workspace.writeExecutable(
      "lsof",
      [
        "#!/usr/bin/env bash",
        'port=""',
        'for arg in "$@"; do',
        '  case "$arg" in :*) port="${arg#:}";; esac',
        "done",
        `if [ "$port" = ${JSON.stringify(String(gatewayPort))} ]; then`,
        '  if [ "$1" = -ti ]; then printf "%s\\n" "$PPID"; exit 0; fi',
        `  echo "python3 $PPID test 1u IPv4 TCP 127.0.0.1:${String(gatewayPort)} (LISTEN)"`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    workspace.remove();
  });

  it(
    "rejects a foreign listener without waiting on lifecycle inspection",
    testTimeoutOptions(15_000),
    () => {
      const result = runOnboardProcess(
        [CLI, "onboard", "--name", "foreign-port", "--no-gpu", "--non-interactive"],
        {
          timeoutMs: 10_000,
          env: workspaceEnv(workspace, {
            NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
            NEMOCLAW_GATEWAY_PORT: String(gatewayPort),
            NEMOCLAW_OPENSHELL_BIN: path.join(workspace.binDir, "openshell"),
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_OPENSHELL_GATEWAY_BIN: path.join(workspace.binDir, "openshell-gateway"),
            NEMOCLAW_OPENSHELL_SANDBOX_BIN: path.join(workspace.binDir, "openshell-sandbox"),
            NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT: "1",
            NEMOCLAW_TEST_NO_SLEEP: "1",
          }),
        },
      );

      const combined = result.output;
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBeGreaterThan(0);
      expect(combined).toMatch(
        new RegExp(`(?:Port|Gateway port) ${String(gatewayPort)} (?:is not available|is occupied)`),
      );
      expect(combined).toMatch(
        /The gateway port is held by an incompatible or ambiguous owner|OpenShell gateway needs this port/,
      );
      expect(combined).not.toMatch(/occupied by unknown/);
      expect(combined).toMatch(/\(PID \d+\)/);
      expect(combined).toContain(
        `sudo lsof -i :${String(gatewayPort)} -sTCP:LISTEN -P -n`,
      );
      expect(combined).toContain("signal only the matching PID from that fresh result");
      expect(combined).not.toMatch(/sudo kill \d+/);
    },
  );

  it(
    "accepts Server endpoint evidence on repeated production readiness probes",
    testTimeoutOptions(30_000),
    async () => {
      const gatewayName = resolveGatewayName(gatewayPort);
      const gatewayEndpoint = `https://127.0.0.1:${String(gatewayPort)}/`;
      const gatewayStatus = [
        "Server Status",
        "",
        `Gateway: ${gatewayName}`,
        `Server: ${gatewayEndpoint}`,
        "Status: Connected",
        "",
      ].join("\n");
      const gatewayInfo = [
        "Gateway Info",
        "",
        `Gateway: ${gatewayName}`,
        `Server: ${gatewayEndpoint}`,
        "",
      ].join("\n");

      ["openshell", "openshell-gateway", "openshell-sandbox"].forEach((component) => {
        workspace.writeExecutable(
          component,
          [
            "#!/usr/bin/env bash",
            "# openshell capabilities: request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods",
            'case "$*" in',
            '  --version|-V) printf "%s 0.0.106\\n" "${0##*/}"; exit 0;;',
            `  status|"status -g ${gatewayName}") printf ${JSON.stringify(gatewayStatus)}; exit 0;;`,
            `  "gateway info"|"gateway info -g ${gatewayName}") printf ${JSON.stringify(gatewayInfo)}; exit 0;;`,
            "esac",
            "exit 1",
          ].join("\n"),
        );
      });

      const containerName = getGatewayClusterContainerName(gatewayName);
      const portBindings = JSON.stringify({
        [`${String(gatewayPort)}/tcp`]: [{ HostPort: String(gatewayPort) }],
      });
      workspace.writeExecutable(
        "docker",
        [
          "#!/usr/bin/env bash",
          `if [ "$1" = info ]; then printf '%s\\n' ${JSON.stringify(
            JSON.stringify({
              ServerVersion: "24.0.0",
              OperatingSystem: "Docker Desktop",
              NCPU: 8,
              MemTotal: 17_179_869_184,
            }),
          )}; exit 0; fi`,
          'if [ "$1" = ps ]; then exit 0; fi',
          'if [ "$1" = inspect ] && [ "$4" = ' + JSON.stringify(containerName) + " ]; then",
          '  case "$3" in',
          '    "{{.State.Running}}") printf "true\\n";;',
          `    "{{json .NetworkSettings.Ports}}") printf '%s\\n' ${JSON.stringify(portBindings)};;`,
          '    "{{.Config.Image}}") printf "nvcr.io/nvidia/openshell/cluster:0.0.106\\n";;',
          "    *) exit 1;;",
          "  esac",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
      );
      workspace.writeExecutable("lsof", "#!/usr/bin/env bash\nexit 1\n");

      vi.stubEnv("HOME", workspace.homeDir);
      vi.stubEnv("PATH", `${workspace.binDir}:${process.env.PATH || ""}`);
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(gatewayPort));
      vi.stubEnv(
        "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
        path.join(workspace.binDir, "openshell-gateway"),
      );
      workspace.writeExecutable("sudo", "#!/usr/bin/env bash\nexit 1\n");

      const readiness = createProductionGatewayReadinessDependencies({
        gatewayName: () => gatewayName,
        gatewayPort: () => gatewayPort,
      });
      const owner = readiness.resolveOwner();
      [
        await readiness.observeManagedGateway(owner),
        await readiness.observeManagedGateway(owner),
      ].forEach((result) => {
        expect(result.reuseState).toBe("healthy");
        expect(result.portConflictState).toBe("none");
      });
    },
  );
});
