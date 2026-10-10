// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { mockGatewayProcFiles } from "../../../../test/helpers/mock-gateway-proc-files";
import { mockGatewayProcTaskDir } from "../../../../test/helpers/mock-gateway-proc-task-dir";
import { writeDockerDriverGatewayRuntimeMarkerForStateDir } from "../../onboard/docker-driver-gateway-runtime-marker";

const requireDist = createRequire(import.meta.url);
const {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  formatOpenShellStateRpcIssue,
  getGatewayClusterImageDrift,
  getGatewayHostProcessDrift,
  getHostProcessGatewayRuntimeOrNull,
  isGatewayClusterActiveForGateway,
  observeOpenShellGatewayVersionCompatibility,
  parseGatewayClusterImageVersion,
} = requireDist("./gateway-drift.ts") as typeof import("./gateway-drift");

describe("OpenShell gateway drift preflight", () => {
  let spies: MockInstance[] = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
    vi.unstubAllEnvs();
  });

  it("parses OpenShell cluster image versions", () => {
    expect(parseGatewayClusterImageVersion("ghcr.io/nvidia/openshell/cluster:0.0.36")).toBe(
      "0.0.36",
    );
    expect(parseGatewayClusterImageVersion("example.com/other/image:0.0.36")).toBeNull();
  });

  it("detects a running gateway image that differs from the installed OpenShell version", async () => {
    const drift = await getGatewayClusterImageDrift({
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

  it("does not flag matching gateway image versions", async () => {
    expect(
      await detectOpenShellStateRpcPreflightIssue({
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

  it("ignores stale legacy cluster images when that container is not the active gateway", async () => {
    expect(
      await getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.36",
          isGatewayClusterActive: () => false,
        },
      }),
    ).toBeNull();
  });

  it("uses the typed reuse observer when checking the active cluster gateway", async () => {
    const openshellRuntime = requireDist("./runtime.js");
    const docker = requireDist("../docker/inspect.js");
    spies.push(
      vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((rawArgs: unknown) => {
        const args = rawArgs as string[];
        if (args.join(" ") === "status -g nemoclaw") {
          return {
            status: 0,
            output: "Server Status\n\n  Gateway: nemoclaw\n  Status: Connected",
          };
        }
        return {
          status: 0,
          output: '[{"name":"nemoclaw","endpoint":"https://127.0.0.1:8080","active":true}]',
        };
      }),
      vi.spyOn(docker, "dockerContainerInspectFormat").mockImplementation((rawFormat: unknown) => {
        const format = String(rawFormat);
        if (format === "{{.State.Running}}") return "true";
        if (format === "{{json .NetworkSettings.Ports}}") {
          return '{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}';
        }
        return "ghcr.io/nvidia/openshell/cluster:0.0.36";
      }),
    );

    expect(
      await getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
        },
      }),
    ).toMatchObject({
      currentVersion: "0.0.36",
      expectedVersion: "0.0.37",
    });
    expect(await isGatewayClusterActiveForGateway("nemoclaw", { expectedGatewayPort: 8080 })).toBe(
      true,
    );
    expect(await isGatewayClusterActiveForGateway("nemoclaw", { expectedGatewayPort: 9090 })).toBe(
      false,
    );
  });

  it("fails closed when the typed gateway observation fails", async () => {
    const docker = requireDist("../docker/inspect.js");
    const inspectContainer = vi.spyOn(docker, "dockerContainerInspectFormat");
    spies.push(inspectContainer);
    const observeGatewayReuse = vi.fn().mockResolvedValue({
      gatewayReuseState: "missing",
      healthy: false,
      namedMetadata: false,
      shouldSelect: false,
      endpoints: [],
      endpointBinding: "unknown",
      error: { kind: "schema", message: "Gateway observation failed." },
    });

    expect(
      await isGatewayClusterActiveForGateway("nemoclaw", {
        expectedGatewayPort: 8080,
        observer: { observeGatewayReuse },
      }),
    ).toBe(false);
    expect(observeGatewayReuse).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      expectedGatewayPort: 8080,
      timeoutMs: expect.any(Number),
    });
    expect(inspectContainer).not.toHaveBeenCalled();
  });

  it("pins gateway health probes to the frozen OpenShell target (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.example.invalid");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    const openshellRuntime = requireDist("./runtime.js");
    const docker = requireDist("../docker/inspect.js");
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValueOnce({
        status: 0,
        output: "Server Status\n\n  Gateway: nemoclaw-9090\n  Status: Connected",
      })
      .mockReturnValue({
        status: 0,
        output: '[{"name":"nemoclaw-9090","endpoint":"https://127.0.0.1:9090","active":true}]',
      });
    const inspectContainer = vi
      .spyOn(docker, "dockerContainerInspectFormat")
      .mockReturnValueOnce("true")
      .mockReturnValue('{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"9090"}]}');
    spies.push(captureOpenshell, inspectContainer);
    const runtimeSelection = {
      gatewayName: "nemoclaw-9090",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };

    expect(
      await isGatewayClusterActiveForGateway(runtimeSelection.gatewayName, {
        expectedGatewayPort: 9090,
        runtimeSelection,
      }),
    ).toBe(true);
    const selectedProbeOptions = expect.objectContaining({
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-9090",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        OPENSHELL_WORKSPACE: "default",
      }),
      replaceEnv: true,
    });
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["status", "-g", "nemoclaw-9090"],
      selectedProbeOptions,
    );
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["gateway", "list", "-o", "json"],
      selectedProbeOptions,
    );
    const firstProbeOptions = captureOpenshell.mock.calls[0]?.[1] as
      | { env?: Record<string, string> }
      | undefined;
    const selectedEnv = firstProbeOptions?.env;
    expect(selectedEnv).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(selectedEnv).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it("ignores stale cluster containers whose published port is not the active gateway endpoint", async () => {
    const openshellRuntime = requireDist("./runtime.js");
    const docker = requireDist("../docker/inspect.js");
    spies.push(
      vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((rawArgs: unknown) => {
        const args = rawArgs as string[];
        if (args.join(" ") === "status -g nemoclaw") {
          return {
            status: 0,
            output: "Server Status\n\n  Gateway: nemoclaw\n  Status: Connected",
          };
        }
        return {
          status: 0,
          output: '[{"name":"nemoclaw","endpoint":"http://127.0.0.1:18081","active":true}]',
        };
      }),
      vi.spyOn(docker, "dockerContainerInspectFormat").mockImplementation((rawFormat: unknown) => {
        const format = String(rawFormat);
        if (format === "{{.State.Running}}") return "true";
        if (format === "{{json .NetworkSettings.Ports}}") {
          return '{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}';
        }
        return "ghcr.io/nvidia/openshell/cluster:0.0.36";
      }),
    );

    expect(
      await getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
        },
      }),
    ).toBeNull();
  });

  it("detects a newer gateway image as schema drift", async () => {
    const issue = await detectOpenShellStateRpcPreflightIssue({
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

  it("ignores the host Docker gateway when the Vitest sentinel is set", async () => {
    expect(process.env.VITEST).toBe("true");
    expect(process.env.NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT).toBe("1");

    expect(
      await getGatewayClusterImageDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.37",
          getGatewayClusterImageRef: () => "ghcr.io/nvidia/openshell/cluster:0.0.38",
        },
      }),
    ).not.toBeNull();
    expect(await getGatewayClusterImageDrift()).toBeNull();
  });

  it("detects host-process gateway binary drift when no cluster container exists", async () => {
    const drift = await getGatewayHostProcessDrift({
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

  it.runIf(process.platform === "linux")(
    "selects the marker gateway from a live sibling when the leader is a zombie",
    () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-drift-zombie-"));
      const gatewayBin = path.join(stateDir, "openshell-gateway");
      const pid = 9_999_811;
      const tid = pid + 1;
      const proc = `/proc/${pid}`;
      try {
        fs.writeFileSync(gatewayBin, "#!/bin/sh\nprintf 'openshell-gateway 0.0.43\\n'\n", {
          mode: 0o700,
        });
        writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
          pid,
          desiredEnv: {},
          endpoint: "https://127.0.0.1:18080",
          gatewayBin,
        });
        vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDir);
        vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_BIN", path.join(stateDir, "other-gateway"));
        const files = new Map<string, string>([
          [`${proc}/cmdline`, ""],
          [`${proc}/status`, "State:\tZ (zombie)\n"],
          [`${proc}/task/${tid}/cmdline`, `${gatewayBin}\0--name\0nemoclaw-18080\0`],
        ]);
        const readFile = fs.readFileSync;
        vi.spyOn(fs, "readFileSync").mockImplementation(
          (file, options) => files.get(String(file)) ?? readFile(file, options),
        );
        mockGatewayProcFiles(files);
        mockGatewayProcTaskDir(`${proc}/task`, [String(pid), String(tid)]);
        vi.spyOn(process, "kill").mockReturnValue(true);

        expect(getHostProcessGatewayRuntimeOrNull()).toEqual({
          gatewayBin,
          runningVersion: "0.0.43",
        });
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux").each([
    { prefix: "", selected: "openshell-gateway", version: "0.0.43" },
    { prefix: "/usr/bin/vim ", selected: "other-gateway", version: "0.0.44" },
  ])(
    "selects $selected after an oversized command with ps prefix '$prefix'",
    ({ prefix, selected, version }) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-drift-oversized-"));
      const gatewayBin = path.join(stateDir, "openshell-gateway");
      const fallbackBin = path.join(stateDir, "other-gateway");
      const pid = 9_999_811;
      try {
        fs.writeFileSync(gatewayBin, "#!/bin/sh\nprintf 'openshell-gateway 0.0.43\\n'\n", {
          mode: 0o700,
        });
        fs.writeFileSync(fallbackBin, "#!/bin/sh\nprintf 'openshell-gateway 0.0.44\\n'\n", {
          mode: 0o700,
        });
        writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
          pid,
          desiredEnv: {},
          endpoint: "https://127.0.0.1:18080",
          gatewayBin,
        });
        vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDir);
        vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_BIN", fallbackBin);
        mockGatewayProcFiles(
          new Map([
            [`/proc/${pid}/cmdline`, `${gatewayBin}\0${"x".repeat(65_536)}`],
            [`/proc/${pid}/status`, "State:\tS (sleeping)\n"],
          ]),
        );
        vi.spyOn(process, "kill").mockReturnValue(true);
        const childProcess = requireDist("node:child_process");
        const ps = vi.spyOn(childProcess, "spawnSync").mockImplementationOnce(() => ({
          status: 0,
          stdout: `${prefix}${gatewayBin}`,
          stderr: "",
        }));
        expect(getHostProcessGatewayRuntimeOrNull()).toEqual({
          gatewayBin: path.join(stateDir, selected),
          runningVersion: version,
        });
        expect(ps).toHaveBeenCalledWith(
          "ps",
          ["-p", String(pid), "-o", "args="],
          expect.anything(),
        );
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("does not flag a matching host-process gateway binary", async () => {
    expect(
      await getGatewayHostProcessDrift({
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

  it("does not probe host-process drift while an active cluster gateway is present", async () => {
    let runtimeProbed = false;
    expect(
      await getGatewayHostProcessDrift({
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

  it("detects host-process drift when a leftover cluster container exists but is not active", async () => {
    const drift = await getGatewayHostProcessDrift({
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

  it("returns null when the host-process gateway version cannot be probed", async () => {
    expect(
      await getGatewayHostProcessDrift({
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

  it.each([
    ["0.0.44", "compatible"],
    ["0.0.43", "drift"],
    [null, "unknown"],
  ] as const)(
    "reports host-process running version %s as %s readiness evidence",
    async (runningVersion, expected) => {
      expect(
        await observeOpenShellGatewayVersionCompatibility({
          source: "host-process",
          deps: {
            getInstalledOpenshellVersion: () => "0.0.44",
            getGatewayClusterImageRef: () => null,
            getHostProcessGatewayRuntime: () => ({
              gatewayBin: "/home/u/.local/bin/openshell-gateway",
              runningVersion,
            }),
          },
        }),
      ).toBe(expected);
    },
  );

  it("keeps version compatibility unknown without an installed version", async () => {
    expect(
      await observeOpenShellGatewayVersionCompatibility({
        source: "host-process",
        deps: {
          getInstalledOpenshellVersion: () => null,
          getGatewayClusterImageRef: () => null,
          getHostProcessGatewayRuntime: () => ({
            gatewayBin: "/home/u/.local/bin/openshell-gateway",
            runningVersion: "0.0.44",
          }),
        },
      }),
    ).toBe("unknown");
  });

  it("does not fall from an unproven legacy cluster to an unrelated host binary", async () => {
    const getHostProcessGatewayRuntime = vi.fn(() => ({
      gatewayBin: "/home/u/.local/bin/openshell-gateway",
      runningVersion: "0.0.44",
    }));

    expect(
      await observeOpenShellGatewayVersionCompatibility({
        source: "legacy-cluster",
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => null,
          isGatewayClusterActive: () => false,
          getHostProcessGatewayRuntime,
        },
      }),
    ).toBe("unknown");
    expect(getHostProcessGatewayRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["ghcr.io/nvidia/openshell/cluster:0.0.44", "compatible"],
    ["ghcr.io/nvidia/openshell/cluster:0.0.43", "drift"],
    ["example.com/cluster:latest", "unknown"],
  ] as const)("reports bound legacy cluster image %s as %s", async (image, expected) => {
    expect(
      await observeOpenShellGatewayVersionCompatibility({
        source: "legacy-cluster",
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => image,
          isGatewayClusterActive: () => true,
        },
      }),
    ).toBe(expected);
  });

  it("surfaces host-process drift as a preflight issue when cluster image drift is absent", async () => {
    const issue = await detectOpenShellStateRpcPreflightIssue({
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

  it("ignores host-process gateway drift when the Vitest sentinel is set", async () => {
    expect(process.env.VITEST).toBe("true");
    expect(process.env.NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT).toBe("1");

    // Injected deps opt back into detection; the bare call stays disabled.
    expect(
      await getGatewayHostProcessDrift({
        deps: {
          getInstalledOpenshellVersion: () => "0.0.44",
          getGatewayClusterImageRef: () => null,
          getHostProcessGatewayRuntime: () => ({ gatewayBin: "/x", runningVersion: "0.0.43" }),
        },
      }),
    ).not.toBeNull();
    expect(await getGatewayHostProcessDrift()).toBeNull();
  });

  it("classifies protobuf invalid-wire output as an unsafe OpenShell state result", async () => {
    const issue = await detectOpenShellStateRpcResultIssue(
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

  it("attaches host-process drift to a protobuf mismatch when there is no cluster container", async () => {
    const issue = await detectOpenShellStateRpcResultIssue(
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
