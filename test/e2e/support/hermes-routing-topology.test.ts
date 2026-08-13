// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { type CommandRunner, SandboxClient } from "../fixtures/clients/index.ts";
import {
  assertHermesHasNoRoutingSidecars,
  buildHermesRoutingTopologyProbeScript,
  captureHermesRoutingTopology,
  type HermesRoutingTopology,
  parseHermesRoutingTopology,
} from "../fixtures/hermes-routing-topology.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

const SIDECAR_FREE_TOPOLOGY: HermesRoutingTopology = {
  schema_version: 1,
  gateway_processes: [
    {
      pid: 404,
      ppid: 22,
      uid: 1000,
    },
  ],
  sidecars: {
    nemo_relay_pids: [],
    switchyard_server_pids: [],
    total: 0,
  },
};

function withFakeProcRoot<T>(run: (procRoot: string) => T): T {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-routing-proc-"));
  try {
    return run(procRoot);
  } finally {
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
}

function writeProcess(
  procRoot: string,
  pid: number,
  args: string[],
  options: { ppid?: number; uid?: number } = {},
): void {
  const processRoot = path.join(procRoot, String(pid));
  fs.mkdirSync(processRoot);
  fs.writeFileSync(path.join(processRoot, "cmdline"), Buffer.from(`${args.join("\0")}\0`));
  fs.writeFileSync(
    path.join(processRoot, "status"),
    [
      `Name:\t${path.basename(args[0] ?? "unknown")}`,
      `PPid:\t${options.ppid ?? 1}`,
      `Uid:\t${options.uid ?? 1000}\t${options.uid ?? 1000}\t${options.uid ?? 1000}\t${options.uid ?? 1000}`,
      "",
    ].join("\n"),
  );
}

function spawnTopologyProbe(procRoot: string) {
  return spawnSync("sh", ["-c", buildHermesRoutingTopologyProbeScript(procRoot)], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 5_000,
  });
}

function runTopologyProbe(procRoot: string): { stderr: string; topology: HermesRoutingTopology } {
  const result = spawnTopologyProbe(procRoot);
  expect(result.status, result.stderr).toBe(0);
  return {
    stderr: result.stderr,
    topology: parseHermesRoutingTopology(result.stdout.trim()),
  };
}

function shellResult(stdout: string): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    artifacts: {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      result: "/tmp/result",
    },
  };
}

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ args: string[]; command: string; options?: ShellProbeRunOptions }> = [];

  constructor(private readonly response: ShellProbeResult) {}

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    return this.response;
  }
}

describe("Hermes routing topology probe", () => {
  it("records a sidecar-free routing topology without mistaking probe text for processes (#8889)", () =>
    withFakeProcRoot((procRoot) => {
      writeProcess(
        procRoot,
        404,
        ["/opt/hermes/.venv/bin/python", "/opt/hermes/.venv/bin/hermes", "gateway", "run"],
        { ppid: 22 },
      );
      writeProcess(procRoot, 405, [
        "sh",
        "-lc",
        "diagnostic text mentions hermes gateway run, nemo-relay, and switchyard-server",
      ]);

      const { stderr, topology } = runTopologyProbe(procRoot);

      expect(stderr).toBe("");
      expect(topology).toEqual(SIDECAR_FREE_TOPOLOGY);
      expect(assertHermesHasNoRoutingSidecars(topology, 404)).toEqual(
        SIDECAR_FREE_TOPOLOGY.gateway_processes[0],
      );
    }));

  it("detects both external sidecar shapes from process metadata only (#8889)", () =>
    withFakeProcRoot((procRoot) => {
      writeProcess(procRoot, 500, ["/opt/hermes/.venv/bin/hermes", "gateway", "run"], {
        ppid: 40,
      });
      writeProcess(procRoot, 501, ["/opt/nemo-relay/bin/nemo-relay", "serve"]);
      writeProcess(procRoot, 502, ["python3", "-m", "switchyard_server", "--port", "8899"]);

      const { topology } = runTopologyProbe(procRoot);

      expect(topology).toEqual({
        schema_version: 1,
        gateway_processes: [
          {
            pid: 500,
            ppid: 40,
            uid: 1000,
          },
        ],
        sidecars: {
          nemo_relay_pids: [501],
          switchyard_server_pids: [502],
          total: 2,
        },
      });
    }));

  it("rejects sidecars, duplicate gateways, or an unexpected gateway PID (#8889)", () => {
    expect(() =>
      assertHermesHasNoRoutingSidecars(
        {
          ...SIDECAR_FREE_TOPOLOGY,
          sidecars: { nemo_relay_pids: [505], switchyard_server_pids: [], total: 1 },
        },
        404,
      ),
    ).toThrow("expected zero standalone NeMo Relay/Switchyard sidecars");
    expect(() =>
      assertHermesHasNoRoutingSidecars({
        ...SIDECAR_FREE_TOPOLOGY,
        gateway_processes: [
          ...SIDECAR_FREE_TOPOLOGY.gateway_processes,
          { pid: 405, ppid: 22, uid: 1000 },
        ],
      }),
    ).toThrow("expected exactly one Hermes gateway process, observed 2");
    expect(() => assertHermesHasNoRoutingSidecars(SIDECAR_FREE_TOPOLOGY, 999)).toThrow(
      "expected Hermes gateway PID 999",
    );
  });

  it("rejects internally inconsistent topology evidence (#8889)", () => {
    expect(() =>
      parseHermesRoutingTopology(
        JSON.stringify({
          ...SIDECAR_FREE_TOPOLOGY,
          sidecars: { nemo_relay_pids: [501], switchyard_server_pids: [], total: 0 },
        }),
      ),
    ).toThrow("does not match observed process count 1");
    expect(() =>
      parseHermesRoutingTopology(
        JSON.stringify({
          ...SIDECAR_FREE_TOPOLOGY,
          gateway_processes: [
            ...SIDECAR_FREE_TOPOLOGY.gateway_processes,
            SIDECAR_FREE_TOPOLOGY.gateway_processes[0],
          ],
        }),
      ),
    ).toThrow("gateway_processes must not contain duplicate PIDs");
  });

  it("captures command evidence plus a normalized routing artifact (#8889)", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-routing-artifacts-"));
    try {
      const runner = new RecordingRunner(shellResult(`${JSON.stringify(SIDECAR_FREE_TOPOLOGY)}\n`));
      const artifacts = new ArtifactSink(artifactRoot);
      const topology = await captureHermesRoutingTopology({
        artifactName: "Phase 5 routing topology before restart",
        artifacts,
        env: { OPENSHELL_GATEWAY: "nemoclaw" },
        sandbox: new SandboxClient(runner),
        sandboxName: "e2e-hermes",
      });

      expect(topology).toEqual(SIDECAR_FREE_TOPOLOGY);
      expect(runner.calls).toEqual([
        expect.objectContaining({
          command: "openshell",
          args: expect.arrayContaining(["sandbox", "exec", "-n", "e2e-hermes", "--", "sh", "-lc"]),
          options: expect.objectContaining({
            artifactName: "Phase 5 routing topology before restart",
            env: { OPENSHELL_GATEWAY: "nemoclaw" },
            timeoutMs: 30_000,
          }),
        }),
      ]);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              artifactRoot,
              "routing-topology",
              "phase-5-routing-topology-before-restart.json",
            ),
            "utf8",
          ),
        ),
      ).toEqual(SIDECAR_FREE_TOPOLOGY);
      expect(
        fs.readFileSync(
          path.join(
            artifactRoot,
            "routing-topology",
            "phase-5-routing-topology-before-restart.raw.txt",
          ),
          "utf8",
        ),
      ).toBe(`${JSON.stringify(SIDECAR_FREE_TOPOLOGY)}\n`);
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("preserves raw probe output when normalized topology parsing fails (#8889)", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-routing-artifacts-"));
    try {
      const artifacts = new ArtifactSink(artifactRoot);
      await expect(
        captureHermesRoutingTopology({
          artifactName: "Malformed routing topology",
          artifacts,
          sandbox: new SandboxClient(new RecordingRunner(shellResult("not-json\n"))),
          sandboxName: "e2e-hermes",
        }),
      ).rejects.toThrow("output is not valid JSON");

      expect(
        fs.readFileSync(
          path.join(artifactRoot, "routing-topology", "malformed-routing-topology.raw.txt"),
          "utf8",
        ),
      ).toBe("not-json\n");
      expect(
        fs.existsSync(
          path.join(artifactRoot, "routing-topology", "malformed-routing-topology.json"),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe proc-root inputs before building a shell probe (#8889)", () => {
    expect(() => buildHermesRoutingTopologyProbeScript("")).toThrow("must be nonempty");
    expect(() => buildHermesRoutingTopologyProbeScript("/proc\0other")).toThrow(
      "contain no NUL bytes",
    );
  });

  it("fails closed when process metadata cannot be inspected (#8889)", () =>
    withFakeProcRoot((procRoot) => {
      const processRoot = path.join(procRoot, "700");
      fs.mkdirSync(processRoot);
      const cmdlinePath = path.join(processRoot, "cmdline");
      fs.writeFileSync(cmdlinePath, Buffer.from("nemo-relay\0serve\0"));
      fs.chmodSync(cmdlinePath, 0o000);
      fs.writeFileSync(
        path.join(processRoot, "status"),
        ["Name:\tnemo-relay", "PPid:\t1", "Uid:\t1000\t1000\t1000\t1000", ""].join("\n"),
      );

      const result = spawnTopologyProbe(procRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("permission denied reading process metadata");
    }));
});
