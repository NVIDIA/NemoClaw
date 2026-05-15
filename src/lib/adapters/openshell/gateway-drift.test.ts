// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  formatOpenShellStateRpcIssue,
  getGatewayClusterImageDrift,
  parseGatewayClusterImageVersion,
} from "../../../../dist/lib/adapters/openshell/gateway-drift";

const requireDist = createRequire(import.meta.url);

describe("OpenShell gateway drift preflight", () => {
  let spies: MockInstance[] = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  it("parses OpenShell cluster image versions", () => {
    expect(
      parseGatewayClusterImageVersion("ghcr.io/nvidia/openshell/cluster:0.0.36"),
    ).toBe("0.0.36");
    expect(parseGatewayClusterImageVersion("example.com/other/image:0.0.36")).toBeNull();
  });

  it("detects a running gateway image that differs from the installed OpenShell version", () => {
    const drift = getGatewayClusterImageDrift({
      deps: {
        getInstalledOpenshellVersion: () => "0.0.37",
        getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.36",
      },
    });

    expect(drift).toMatchObject({
      containerName: "openshell-cluster-nemoclaw",
      currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
      currentVersion: "0.0.36",
      expectedVersion: "0.0.37",
    });
  });

  it("does not flag matching gateway image versions", () => {
    expect(
      detectOpenShellStateRpcPreflightIssue({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.37",
        },
      }),
    ).toBeNull();
  });

  it("ignores stale legacy cluster images when that container is not the active gateway", () => {
    expect(
      getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.36",
          isGatewayClusterActive: () => false,
        },
      }),
    ).toBeNull();
  });

  it("uses the shared gateway-health classifier when checking the active cluster gateway", () => {
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const docker = requireDist("../../../../dist/lib/adapters/docker/inspect.js");
    spies.push(
      vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((rawArgs: unknown) => {
        const args = rawArgs as string[];
        if (args.join(" ") === "status") {
          return { status: 0, output: "Gateway status: Connected\nGateway: nemoclaw" };
        }
        if (args.join(" ") === "gateway info -g nemoclaw") {
          return {
            status: 0,
            output:
              "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
          };
        }
        return {
          status: 0,
          output:
            "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080",
        };
      }),
      vi
        .spyOn(docker, "dockerContainerInspectFormat")
        .mockImplementation((rawFormat: unknown) => {
          const format = String(rawFormat);
          if (format === "{{.State.Running}}") return "true";
          if (format === "{{json .NetworkSettings.Ports}}") {
            return '{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}';
          }
          return "ghcr.io/nvidia/openshell/cluster:0.0.36";
        }),
    );

    expect(
      getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
        },
      }),
    ).toMatchObject({
      currentVersion: "0.0.36",
      expectedVersion: "0.0.37",
    });
  });

  it("ignores stale cluster containers whose published port is not the active gateway endpoint", () => {
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const docker = requireDist("../../../../dist/lib/adapters/docker/inspect.js");
    spies.push(
      vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((rawArgs: unknown) => {
        const args = rawArgs as string[];
        if (args.join(" ") === "status") {
          return {
            status: 0,
            output: "Server Status\n\n  Gateway: nemoclaw\n  Status: Connected",
          };
        }
        return {
          status: 0,
          output:
            "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: http://127.0.0.1:18081",
        };
      }),
      vi
        .spyOn(docker, "dockerContainerInspectFormat")
        .mockImplementation((rawFormat: unknown) => {
          const format = String(rawFormat);
          if (format === "{{.State.Running}}") return "true";
          if (format === "{{json .NetworkSettings.Ports}}") {
            return '{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}';
          }
          return "ghcr.io/nvidia/openshell/cluster:0.0.36";
        }),
    );

    expect(
      getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
        },
      }),
    ).toBeNull();
  });

  it("detects a newer gateway image as schema drift", () => {
    const issue = detectOpenShellStateRpcPreflightIssue({
      deps: {
        getInstalledOpenshellVersion: () => "0.0.37",
        getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.38",
      },
    });

    expect(issue).toMatchObject({
      kind: "image_drift",
      drift: {
        currentVersion: "0.0.38",
        expectedVersion: "0.0.37",
      },
    });
  });

  it("ignores the host Docker gateway when the Vitest sentinel is set", () => {
    expect(process.env.VITEST).toBe("true");
    expect(process.env.NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT).toBe("1");

    expect(
      getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.38",
        },
      }),
    ).not.toBeNull();
    expect(getGatewayClusterImageDrift()).toBeNull();
  });

  it("classifies protobuf invalid-wire output as an unsafe OpenShell state result", () => {
    const issue = detectOpenShellStateRpcResultIssue(
      {
        status: 1,
        output:
          'Error: status: Internal, message: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"',
      },
      {
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.36",
        },
      },
    );

    expect(issue?.kind).toBe("protobuf_mismatch");
    expect(formatOpenShellStateRpcIssue(issue!, { command: "nemoclaw backup-all" })).toEqual(
      expect.arrayContaining([
        "  No sandbox data was changed.",
        expect.stringContaining("nemoclaw backup-all"),
      ]),
    );
  });

  it("formats runtime protobuf mismatches with gateway-specific recovery guidance", () => {
    const lines = formatOpenShellStateRpcIssue(
      {
        kind: "protobuf_mismatch",
        output: "Sandbox.metadata: invalid wire type value: 6",
      },
      {
        action: "querying live sandboxes",
        gatewayName: "custom-gw",
      },
    );

    expect(lines).toContain(
      "  OpenShell gateway/schema mismatch was detected while querying live sandboxes.",
    );
    expect(lines.join("\n")).toContain("openshell-cluster-custom-gw");
    expect(lines.join("\n")).not.toContain("schema preflight failed before");
  });
});
