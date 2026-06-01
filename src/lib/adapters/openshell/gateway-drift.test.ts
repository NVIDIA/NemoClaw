// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  formatOpenShellStateRpcIssue,
  getGatewayClusterImageDrift,
  getGatewayHostProcessDrift,
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
          // An active cluster gateway at the installed version: no drift of
          // either kind. isGatewayClusterActive keeps the host-process probe
          // from falling through to real system state in this unit test.
          isGatewayClusterActive: () => true,
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

  it("detects host-process gateway binary drift when no cluster container exists", () => {
    const drift = getGatewayHostProcessDrift({
      deps: {
        getInstalledOpenshellVersion: () => "0.0.44",
        getGatewayClusterImageRef: () => null,
        getHostProcessGatewayRuntime: () => ({
          gatewayBin: "/home/u/.local/bin/openshell-gateway",
          runningVersion: "0.0.43",
        }),
      },
    });

    expect(drift).toEqual({
      gatewayBin: "/home/u/.local/bin/openshell-gateway",
      currentVersion: "0.0.43",
      expectedVersion: "0.0.44",
    });
  });

  it("does not flag a matching host-process gateway binary", () => {
    expect(
      getGatewayHostProcessDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => null,
          getHostProcessGatewayRuntime: () => ({
            gatewayBin: "/home/u/.local/bin/openshell-gateway",
            runningVersion: "0.0.44",
          }),
        },
      }),
    ).toBeNull();
  });

  it("does not probe host-process drift while an active cluster gateway is present", () => {
    let runtimeProbed = false;
    expect(
      getGatewayHostProcessDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.44",
          isGatewayClusterActive: () => true,
          getHostProcessGatewayRuntime: () => {
            runtimeProbed = true;
            return { gatewayBin: "/x", runningVersion: "0.0.43" };
          },
        },
      }),
    ).toBeNull();
    expect(runtimeProbed).toBe(false);
  });

  it("detects host-process drift when a leftover cluster container exists but is not active", () => {
    const drift = getGatewayHostProcessDrift({
      deps: {
        getInstalledOpenshellVersion: () => "0.0.44",
        // A stopped/leftover cluster container still returns an image ref...
        getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.36",
        // ...but it is not the active gateway, so it must not mask host drift.
        isGatewayClusterActive: () => false,
        getHostProcessGatewayRuntime: () => ({
          gatewayBin: "/home/u/.local/bin/openshell-gateway",
          runningVersion: "0.0.43",
        }),
      },
    });

    expect(drift).toMatchObject({ currentVersion: "0.0.43", expectedVersion: "0.0.44" });
  });

  it("returns null when the host-process gateway version cannot be probed", () => {
    expect(
      getGatewayHostProcessDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => null,
          getHostProcessGatewayRuntime: () => ({
            gatewayBin: "/home/u/.local/bin/openshell-gateway",
            runningVersion: null,
          }),
        },
      }),
    ).toBeNull();
  });

  it("surfaces host-process drift as a preflight issue when cluster image drift is absent", () => {
    const issue = detectOpenShellStateRpcPreflightIssue({
      deps: {
        getInstalledOpenshellVersion: () => "0.0.44",
        getGatewayClusterImageRef: () => null,
        getHostProcessGatewayRuntime: () => ({
          gatewayBin: "/home/u/.local/bin/openshell-gateway",
          runningVersion: "0.0.43",
        }),
      },
    });

    expect(issue).toMatchObject({
      kind: "host_process_drift",
      drift: { currentVersion: "0.0.43", expectedVersion: "0.0.44" },
    });
  });

  it("formats host-process drift with a running gateway binary line and preflight phase", () => {
    const lines = formatOpenShellStateRpcIssue(
      {
        kind: "host_process_drift",
        drift: {
          gatewayBin: "/home/u/.local/bin/openshell-gateway",
          currentVersion: "0.0.43",
          expectedVersion: "0.0.44",
        },
      },
      { action: "backing up registered sandboxes", command: "nemoclaw backup-all" },
    );

    const joined = lines.join("\n");
    expect(joined).toContain(
      "OpenShell gateway schema preflight failed before backing up registered sandboxes.",
    );
    expect(joined).toContain("Installed OpenShell: 0.0.44");
    expect(joined).toContain(
      "Running gateway binary: /home/u/.local/bin/openshell-gateway (0.0.43)",
    );
    expect(joined).toContain("No sandbox data was changed.");
    expect(joined).toContain("nemoclaw backup-all");
    // Host-process gateways have no cluster container; do not reference its volumes.
    expect(joined).not.toContain("openshell-cluster-nemoclaw");
    expect(joined).not.toContain("Running gateway image");
  });

  it("ignores host-process gateway drift when the Vitest sentinel is set", () => {
    expect(process.env.VITEST).toBe("true");
    expect(process.env.NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT).toBe("1");

    // Injected deps opt back into detection; the bare call stays disabled.
    expect(
      getGatewayHostProcessDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => null,
          getHostProcessGatewayRuntime: () => ({ gatewayBin: "/x", runningVersion: "0.0.43" }),
        },
      }),
    ).not.toBeNull();
    expect(getGatewayHostProcessDrift()).toBeNull();
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

  it("attaches host-process drift to a protobuf mismatch when there is no cluster container", () => {
    const issue = detectOpenShellStateRpcResultIssue(
      {
        status: 1,
        output:
          'Error: status: Internal, message: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"',
      },
      {
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => null,
          getHostProcessGatewayRuntime: () => ({
            gatewayBin: "/home/u/.local/bin/openshell-gateway",
            runningVersion: "0.0.43",
          }),
        },
      },
    );

    expect(issue?.kind).toBe("protobuf_mismatch");
    expect(issue?.drift).toMatchObject({
      gatewayBin: "/home/u/.local/bin/openshell-gateway",
      currentVersion: "0.0.43",
      expectedVersion: "0.0.44",
    });
    const joined = formatOpenShellStateRpcIssue(issue!).join("\n");
    expect(joined).toContain(
      "Running gateway binary: /home/u/.local/bin/openshell-gateway (0.0.43)",
    );
  });

  it("formats runtime protobuf mismatches with gateway-neutral recovery guidance when drift is unknown", () => {
    const lines = formatOpenShellStateRpcIssue(
      {
        kind: "protobuf_mismatch",
        output: "Sandbox.metadata: invalid wire type value: 6",
      },
      {
        action: "querying live sandboxes",
      },
    );

    const joined = lines.join("\n");
    expect(lines).toContain(
      "  OpenShell gateway/schema mismatch was detected while querying live sandboxes.",
    );
    expect(joined).toContain("preserve sandbox state first");
    expect(joined).toContain("No sandbox data was changed.");
    // Driver is unknown when no drift was resolved: do not name a cluster container.
    expect(joined).not.toContain("openshell-cluster");
    expect(joined).not.toContain("Docker volumes");
    expect(joined).not.toContain("schema preflight failed before");
  });
});
