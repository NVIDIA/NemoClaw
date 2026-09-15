// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  cleanupStationRuntime,
  createStationCleanupCommand,
  STATION_STATE_VOLUME,
  STATION_SANDBOX,
} from "../../../tools/e2e/dgx-station-cleanup.mts";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  stationVllmCommands,
  assertStationWorkload,
  assertStationInference,
  assertStationReady,
  assertStationVllm,
  runStationExpressSmoke,
  stationModelCacheMetadata,
  stationSmokeEnvironment,
  STATION_SMOKE_MODEL,
  STATION_SMOKE_SANDBOX,
} from "./dgx-station-express.ts";

const workspace = `/var/tmp/nemoclaw-station-e2e/${"a".repeat(64)}`;
const base = {
  HOME: "/home/station-runner",
  NEMOCLAW_STATION_RUNNER_HOME: "/home/station-runner",
  NEMOCLAW_STATION_WORKSPACE: workspace,
  E2E_MANAGED_IMAGE_REVISION: "b".repeat(40),
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("Station Express smoke boundaries", () => {
  it("keeps model selection in the Express installer and isolates the job environment", () => {
    const env = stationSmokeEnvironment(
      {
        ...base,
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_VLLM_MODEL: "smaller-model",
        NEMOCLAW_MODEL: "untrusted",
        NEMOCLAW_DGX_STATION_PEER: "someone@elsewhere",
        DOCKER_HOST: "tcp://elsewhere",
      },
      "/candidate",
    );
    expect(env).toMatchObject({
      NEMOCLAW_REPO_ROOT: "/candidate",
      HOME: "/home/station-runner",
      NEMOCLAW_PROVIDER: "",
      NEMOCLAW_VLLM_MODEL: "",
      NEMOCLAW_MODEL: "",
      NEMOCLAW_DGX_STATION_PEER: "",
      DOCKER_CONTEXT: "default",
      DOCKER_HOST: "",
      E2E_MANAGED_IMAGE_REVISION: base.E2E_MANAGED_IMAGE_REVISION,
      npm_config_prefix: `${workspace}/npm-prefix`,
      TMPDIR: `/tmp/ncs/${"a".repeat(64)}`,
    });
  });

  it.each([
    { HOME: "/home/operator" },
    { NEMOCLAW_STATION_WORKSPACE: "/var/tmp/../home/operator" },
    { E2E_MANAGED_IMAGE_REVISION: "main" },
  ])("refuses unsafe job scope %j", (override) => {
    expect(() => stationSmokeEnvironment({ ...base, ...override }, "/candidate")).toThrow();
  });

  const container = {
    Image: `sha256:${"c".repeat(64)}`,
    State: { Running: true },
    Config: {
      Labels: { "com.nvidia.nemoclaw.managed-vllm": "true" },
      Entrypoint: ["/bin/bash"],
      Cmd: ["-lc", stationVllmCommands()[0]],
    },
  };
  it("pins the default Ultra serving alias in both Station commands", () => {
    for (const command of stationVllmCommands()) {
      expect(command).toMatch(
        /(?:^|\s)--served-model-name nvidia\/nemotron-3-ultra-550b-a55b(?:\s|$)/u,
      );
    }
  });

  it.each(["", "--served-model-name another/model"])(
    "rejects a Station command with a missing or changed serving alias: %j",
    (replacement) => {
      for (const command of stationVllmCommands()) {
        const changed = command.replace(
          "--served-model-name nvidia/nemotron-3-ultra-550b-a55b",
          replacement,
        );
        expect(() =>
          assertStationVllm(
            JSON.stringify([
              { ...container, Config: { ...container.Config, Cmd: ["-lc", changed] } },
            ]),
          ),
        ).toThrow("default Ultra");
      }
    },
  );

  it("requires managed vLLM to run the default Ultra serving alias", () => {
    expect(assertStationVllm(JSON.stringify([container]))).toBe(container.Image);
    expect(() =>
      assertStationVllm(JSON.stringify([{ ...container, State: { Running: false } }])),
    ).toThrow("must be running");
    expect(() =>
      assertStationVllm(
        JSON.stringify([
          { ...container, Config: { ...container.Config, Cmd: ["serve", "another-model"] } },
        ]),
      ),
    ).toThrow("default Ultra");
    expect(() =>
      assertStationVllm(
        JSON.stringify([{ ...container, Config: { ...container.Config, Labels: {} } }]),
      ),
    ).toThrow("must be running");
  });

  const ready = {
    id: "11111111-1111-4111-8111-111111111111",
    name: STATION_SMOKE_SANDBOX,
    labels: {},
    resource_version: 1,
    created_at: "2026-09-01T00:00:00Z",
    phase: "Ready",
    current_policy_version: 1,
  };
  it("requires an observed ready sandbox with the expected identity", () => {
    expect(() => assertStationReady(JSON.stringify([ready]))).not.toThrow();
    expect(() => assertStationReady(JSON.stringify([{ ...ready, phase: "Creating" }]))).toThrow(
      "ready sandbox",
    );
    expect(() => assertStationReady(JSON.stringify([{ ...ready, name: "unrelated" }]))).toThrow(
      "ready sandbox",
    );
    expect(() => assertStationReady("[]")).toThrow("ready sandbox");
    expect(() => assertStationReady(JSON.stringify([ready, ready]))).toThrow("ready sandbox");
  });

  it.each([
    { model: "other-model", choices: [{ message: { content: "PONG" } }] },
    { model: STATION_SMOKE_MODEL, choices: [{ message: { content: "" } }] },
    { model: STATION_SMOKE_MODEL, choices: [] },
    { error: "unavailable" },
  ])("rejects incomplete or wrongly routed inference %j", (response) => {
    expect(() => assertStationInference(JSON.stringify(response))).toThrow();
  });

  it("accepts non-empty content in an Ultra response payload", () => {
    expect(() =>
      assertStationInference(
        JSON.stringify({ model: STATION_SMOKE_MODEL, choices: [{ message: { content: "PONG" } }] }),
      ),
    ).not.toThrow();
  });

  it("observes cache names, sizes, and symlink targets without writing to the cache", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "station-cache-"));
    directories.push(home);
    const model = path.join(
      home,
      ".cache/huggingface/hub/models--nvidia--NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    );
    fs.mkdirSync(path.join(model, "blobs"), { recursive: true });
    fs.mkdirSync(path.join(model, "snapshots"));
    fs.writeFileSync(path.join(model, "blobs", "a"), "weights");
    fs.symlinkSync("../blobs/a", path.join(model, "snapshots", "weights"));
    const original = stationModelCacheMetadata(home);
    expect(stationModelCacheMetadata(home)).toEqual(original);
    fs.appendFileSync(path.join(model, "blobs", "a"), "changed");
    expect(stationModelCacheMetadata(home).sha256).not.toBe(original.sha256);
    fs.writeFileSync(path.join(model, "blobs", "a"), "weights");
    fs.unlinkSync(path.join(model, "snapshots", "weights"));
    fs.symlinkSync("../blobs/b", path.join(model, "snapshots", "weights"));
    expect(stationModelCacheMetadata(home).sha256).not.toBe(original.sha256);
  });

  it("uninstalls after installer failure and records installer and cleanup durations", async () => {
    const home = cleanupHome();
    let time = 0;
    const controller = new AbortController();
    const cleanup = new CleanupRegistry((value) => value, undefined, {
      testSignal: controller.signal,
    });
    const empty = { stdout: "", stderr: "", exitCode: 0 } as Awaited<
      ReturnType<HostCliClient["command"]>
    >;
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce({ ...empty, stdout: "DGX Station\n" })
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(async () => {
        time += 5000;
        fs.mkdirSync(path.join(home, ".nemoclaw"));
        controller.abort();
        return { ...empty, exitCode: 1 };
      })
      .mockImplementationOnce(async () => {
        expect(cleanup.currentSignal().aborted).toBe(false);
        time += 1000;
        return empty;
      })
      .mockResolvedValue(empty);
    const exec = vi.fn<SandboxClient["exec"]>();
    const writeEvidence = vi.fn(async () => {});
    const phases = { inspect: vi.fn(), install: vi.fn(), assert: vi.fn(), cleanup: vi.fn() };
    await expect(
      runStationExpressSmoke({
        cleanup,
        host: { command },
        sandbox: { exec },
        environment: { ...base, HOME: home, NEMOCLAW_STATION_RUNNER_HOME: home },
        repoRoot: "/candidate",
        phases,
        writeEvidence,
        now: () => time,
        modelCacheMetadata: () => ({ sha256: "baseline", entries: 1 }),
      }),
    ).rejects.toThrow("station-express-install failed");
    expect(command).toHaveBeenCalledWith(
      "bash",
      ["install.sh", "--express-install", "--yes-i-accept-third-party-software"],
      expect.objectContaining({
        cwd: "/candidate",
        env: expect.objectContaining({ NEMOCLAW_REPO_ROOT: "/candidate" }),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      "bash",
      ["uninstall.sh", "--yes", "--destroy-user-data"],
      expect.anything(),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(phases.inspect).toHaveBeenCalledOnce();
    expect(phases.install).toHaveBeenCalledOnce();
    expect(phases.assert).not.toHaveBeenCalled();
    expect(phases.cleanup).toHaveBeenCalledOnce();
    expect(phases.inspect.mock.invocationCallOrder[0]).toBeLessThan(
      phases.install.mock.invocationCallOrder[0]!,
    );
    expect(phases.install.mock.invocationCallOrder[0]).toBeLessThan(
      phases.cleanup.mock.invocationCallOrder[0]!,
    );
    expect(writeEvidence).toHaveBeenCalledWith("station-express-timings.json", {
      installMs: 5000,
      cleanupMs: 1000,
      totalMs: 6000,
      cleanup: "succeeded",
    });
  });
});

it("requires the managed-image revision instead of substituting the candidate code revision", () => {
  const expectedRevision = "b".repeat(40);
  const registry = (revision: string) => ({
    sandboxes: {
      [STATION_SMOKE_SANDBOX]: { workload: { kind: "managed-image", sourceRevision: revision } },
    },
  });
  expect(() => assertStationWorkload(registry(expectedRevision), expectedRevision)).not.toThrow();
  expect(() => assertStationWorkload(registry("a".repeat(40)), expectedRevision)).toThrow(
    "independently selected",
  );
  expect(() => assertStationWorkload({ sandboxes: {} }, expectedRevision)).toThrow();
});

function cleanupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "station-cleanup-"));
  directories.push(home);
  return home;
}
const leftover = {
  Name: STATION_STATE_VOLUME,
  Driver: "local",
  Scope: "local",
  Options: null,
  Labels: {
    "io.nvidia.nemoclaw.openclaw-state.managed": "true",
    "io.nvidia.nemoclaw.openclaw-state.schema": "1",
    "io.nvidia.nemoclaw.openclaw-state.sandbox": STATION_SANDBOX,
    "io.nvidia.nemoclaw.openclaw-state.target": "/sandbox/.openclaw",
  },
};
const cleanupCommand = () =>
  vi.fn<
    (label: string, executable: string, args: string[], timeoutMs?: number) => Promise<string>
  >();

describe("Station CI runtime cleanup", () => {
  it("uninstalls the registered sandbox before checking the volume inventory", async () => {
    const home = cleanupHome();
    fs.mkdirSync(path.join(home, ".nemoclaw"));
    fs.writeFileSync(
      path.join(home, ".nemoclaw/sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          [STATION_SANDBOX]: { agent: "openclaw", workload: { kind: "managed-image" } },
        },
      }),
    );
    const command = cleanupCommand()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("keep\n")
      .mockResolvedValueOnce("keep\n");
    await expect(
      cleanupStationRuntime({ home, repoRoot: "/candidate", baselineVolumes: ["keep"], command }),
    ).resolves.toEqual({ uninstalled: true, fallbackVolumes: [] });
    expect(command.mock.calls.map(([label]) => label)).toEqual([
      "station-express-uninstall",
      "station-cleanup-volume-inventory",
      "station-cleanup-volumes-restored",
    ]);
    expect(command).toHaveBeenNthCalledWith(
      1,
      "station-express-uninstall",
      "bash",
      ["uninstall.sh", "--yes", "--destroy-user-data"],
      180_000,
    );
  });

  it("uninstalls remaining installation state when no sandbox row remains", async () => {
    const home = cleanupHome();
    fs.mkdirSync(path.join(home, ".nemoclaw"));
    fs.writeFileSync(
      path.join(home, ".nemoclaw/sandboxes.json"),
      JSON.stringify({ sandboxes: {} }),
    );
    const command = cleanupCommand()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    await expect(
      cleanupStationRuntime({ home, repoRoot: "/candidate", baselineVolumes: [], command }),
    ).resolves.toEqual({ uninstalled: true, fallbackVolumes: [] });
    expect(command.mock.calls[0]?.[0]).toBe("station-express-uninstall");
  });

  it("removes only the unattached owned volume added after the recorded baseline", async () => {
    const command = cleanupCommand()
      .mockResolvedValueOnce(`keep\n${STATION_STATE_VOLUME}\n`)
      .mockResolvedValueOnce(JSON.stringify([leftover]))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("keep\n");
    await expect(
      cleanupStationRuntime({
        home: cleanupHome(),
        repoRoot: "/candidate",
        baselineVolumes: ["keep"],
        command,
      }),
    ).resolves.toEqual({ uninstalled: false, fallbackVolumes: [STATION_STATE_VOLUME] });
    expect(command).toHaveBeenCalledWith("station-leftover-volume-remove", "docker", [
      "volume",
      "rm",
      STATION_STATE_VOLUME,
    ]);
  });

  it.each([
    { ...leftover, Name: "foreign" },
    { ...leftover, Driver: "plugin" },
    { ...leftover, Scope: "global" },
    { ...leftover, Options: { device: "/foreign" } },
    { ...leftover, Labels: {} },
    ...Object.keys(leftover.Labels).map((key) => ({
      ...leftover,
      Labels: { ...leftover.Labels, [key]: "foreign" },
    })),
  ])("refuses unproven leftover ownership %#", async (volume) => {
    const command = cleanupCommand()
      .mockResolvedValueOnce(STATION_STATE_VOLUME)
      .mockResolvedValueOnce(JSON.stringify([volume]));
    await expect(
      cleanupStationRuntime({
        home: cleanupHome(),
        repoRoot: "/candidate",
        baselineVolumes: [],
        command,
      }),
    ).rejects.toThrow("ownership is unproven");
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("stops before volume cleanup when uninstall fails", async () => {
    const home = cleanupHome();
    fs.mkdirSync(path.join(home, ".nemoclaw"));
    const command = cleanupCommand().mockRejectedValue(new Error("uninstall failed"));
    await expect(
      cleanupStationRuntime({ home, repoRoot: "/candidate", baselineVolumes: [], command }),
    ).rejects.toThrow("uninstall failed");
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]?.[0]).toBe("station-express-uninstall");
  });

  it("does not remove a volume while a container is attached", async () => {
    const command = cleanupCommand()
      .mockResolvedValueOnce(STATION_STATE_VOLUME)
      .mockResolvedValueOnce(JSON.stringify([leftover]))
      .mockResolvedValueOnce("container-id");
    await expect(
      cleanupStationRuntime({
        home: cleanupHome(),
        repoRoot: "/candidate",
        baselineVolumes: [],
        command,
      }),
    ).rejects.toThrow("still attached");
    expect(command).toHaveBeenCalledTimes(3);
  });

  it.each(["foreign\n", `${STATION_STATE_VOLUME}\nforeign\n`, ""])(
    "retains unexpected inventory changes: %j",
    async (inventory) => {
      const command = cleanupCommand().mockResolvedValueOnce(inventory);
      await expect(
        cleanupStationRuntime({
          home: cleanupHome(),
          repoRoot: "/candidate",
          baselineVolumes: ["keep"],
          command,
        }),
      ).rejects.toThrow("unexplained change");
      expect(command).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a preexisting Station volume before invoking any cleanup command", async () => {
    const command = cleanupCommand();
    await expect(
      cleanupStationRuntime({
        home: cleanupHome(),
        repoRoot: "/candidate",
        baselineVolumes: [STATION_STATE_VOLUME],
        command,
      }),
    ).rejects.toThrow("present before");
    expect(command).not.toHaveBeenCalled();
  });

  it("reports a failed removal and a volume that remains after successful removal", async () => {
    const failure = cleanupCommand()
      .mockResolvedValueOnce(STATION_STATE_VOLUME)
      .mockResolvedValueOnce(JSON.stringify([leftover]))
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("remove failed"));
    await expect(
      cleanupStationRuntime({
        home: cleanupHome(),
        repoRoot: "/candidate",
        baselineVolumes: [],
        command: failure,
      }),
    ).rejects.toThrow("remove failed");
    const retained = cleanupCommand()
      .mockResolvedValueOnce(STATION_STATE_VOLUME)
      .mockResolvedValueOnce(JSON.stringify([leftover]))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(STATION_STATE_VOLUME);
    await expect(
      cleanupStationRuntime({
        home: cleanupHome(),
        repoRoot: "/candidate",
        baselineVolumes: [],
        command: retained,
      }),
    ).rejects.toThrow("restore the volume baseline");
  });

  it("does not uninstall another sandbox or follow a registry symlink", async () => {
    const home = cleanupHome();
    fs.mkdirSync(path.join(home, ".nemoclaw"));
    const registry = path.join(home, ".nemoclaw/sandboxes.json");
    fs.writeFileSync(registry, JSON.stringify({ sandboxes: { foreign: {} } }));
    const command = cleanupCommand();
    await expect(
      cleanupStationRuntime({ home, repoRoot: "/candidate", baselineVolumes: [], command }),
    ).rejects.toThrow("another sandbox");
    fs.renameSync(registry, registry + ".retained");
    fs.symlinkSync(registry + ".retained", registry);
    await expect(
      cleanupStationRuntime({ home, repoRoot: "/candidate", baselineVolumes: [], command }),
    ).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });
});

it("allows consecutive tsx IPC servers within the generated temporary path length", () => {
  const env = stationSmokeEnvironment(base, "/candidate");
  const worstCaseSocket = `${env.TMPDIR}/tsx-4294967295/4294967295.pipe`;
  expect(Buffer.byteLength(worstCaseSocket)).toBeLessThan(108);
  const root = fs.mkdtempSync("/tmp/ncs-ipc-");
  directories.push(root);
  const tmp = path.join(root, "x".repeat(env.TMPDIR!.length - root.length - 1));
  fs.mkdirSync(tmp);
  const program = path.join(root, "ipc.ts");
  fs.writeFileSync(program, 'process.stdout.write("ready")');
  const executable = path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const first = spawnSync(process.execPath, [executable, program], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
    timeout: 10000,
  });
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toBe("ready");
  const second = spawnSync(process.execPath, [executable, program], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
    timeout: 10000,
  });
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout).toBe("ready");
});

function cleanupProcessRunner(home: string) {
  const artifacts = new ArtifactSink(path.join(home, "command-artifacts"));
  const progress = startTestProgress(
    "Station cleanup command contract",
    ["run the observed cleanup command", "record the cleanup command outcome"],
    { logLine: () => {} },
  );
  const command = createStationCleanupCommand({
    artifacts,
    progress,
    environment: process.env,
    repoRoot: home,
    deadline: Date.now() + 10000,
  });
  return { artifacts, progress, command };
}

it("keeps the event loop available while an observed cleanup command waits", async () => {
  const home = cleanupHome();
  const release = path.join(home, "release");
  const runner = cleanupProcessRunner(home);
  let finished = false;
  const script =
    'const fs = require("node:fs"); const release = process.argv[1]; function check() { if (fs.existsSync(release)) process.stdout.write("done"); else setTimeout(check, 10); } check();';
  const pending = runner
    .command("waiting-cleanup", process.execPath, ["-e", script, release], 5000)
    .then((value) => {
      finished = true;
      return value;
    });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    fs.writeFileSync(release, "continue");
    await expect(pending).resolves.toBe("done");
    const evidence = JSON.parse(
      fs.readFileSync(runner.artifacts.pathFor("shell/waiting-cleanup.result.json"), "utf8"),
    );
    expect(evidence).toMatchObject({ exitCode: 0, timedOut: false });
    runner.progress.phase("record the cleanup command outcome");
    expect(runner.progress.summary().phases[0]?.outputEvents).toBeGreaterThan(0);
  } finally {
    fs.writeFileSync(release, "continue");
    await pending.catch(() => {});
    runner.progress.stop();
  }
});

it("rejects nonzero cleanup commands and preserves redacted command evidence", async () => {
  const runner = cleanupProcessRunner(cleanupHome());
  const secret = `nvapi-${"s".repeat(25)}`;
  try {
    await expect(
      runner.command(
        "failed-cleanup",
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(7)`],
        5000,
      ),
    ).rejects.toThrow("failed-cleanup failed");
    const evidence = fs.readFileSync(
      runner.artifacts.pathFor("shell/failed-cleanup.result.json"),
      "utf8",
    );
    expect(evidence).not.toContain(secret);
    expect(JSON.parse(evidence)).toMatchObject({ exitCode: 7, timedOut: false });
  } finally {
    runner.progress.stop();
  }
});

it("rejects a timed-out cleanup command even if its signal handler exits zero", async () => {
  const runner = cleanupProcessRunner(cleanupHome());
  try {
    await expect(
      runner.command(
        "timeout-cleanup",
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready"); setInterval(() => {}, 1000);',
        ],
        1500,
      ),
    ).rejects.toThrow("timeout-cleanup failed");
    const evidence = JSON.parse(
      fs.readFileSync(runner.artifacts.pathFor("shell/timeout-cleanup.result.json"), "utf8"),
    );
    expect(evidence).toMatchObject({ timedOut: true, stdout: "ready" });
  } finally {
    runner.progress.stop();
  }
});

it("rejects truncated cleanup output instead of accepting its successful exit", async () => {
  const runner = cleanupProcessRunner(cleanupHome());
  try {
    await expect(
      runner.command(
        "oversized-cleanup",
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(1048608))'],
        5000,
      ),
    ).rejects.toThrow("output exceeded its bound");
  } finally {
    runner.progress.stop();
  }
});

function standaloneCleanup(baseline: string) {
  const home = cleanupHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    '#!/bin/sh\n[ "$*" = "volume ls --quiet" ] || exit 9\n',
    { mode: 0o755 },
  );
  const artifacts = path.join(home, "artifacts");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "tools/e2e/dgx-station-cleanup.mts", baseline],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        NEMOCLAW_REPO_ROOT: process.cwd(),
        E2E_ARTIFACT_DIR: artifacts,
      },
    },
  );
  return { artifacts, result };
}

it("runs standalone cleanup through the same TypeScript loader used by the backend", () => {
  const { artifacts, result } = standaloneCleanup("[]");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ uninstalled: false, fallbackVolumes: [] });
  expect(fs.existsSync(path.join(artifacts, "cleanup-error.txt"))).toBe(false);
  expect(result.stderr).toContain("child lifecycle");
  expect(
    fs.statSync(path.join(artifacts, "shell/station-cleanup-volumes-restored.result.json")).mode &
      0o777,
  ).toBe(0o600);
});

it.each([
  ["{}", "Invalid Station volume baseline"],
  [JSON.stringify([STATION_STATE_VOLUME]), "Station state volume was present before the job"],
])("retains a direct cleanup validation failure for baseline %s", (baseline, reason) => {
  const { artifacts, result } = standaloneCleanup(baseline);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe("");
  const errorFile = path.join(artifacts, "cleanup-error.txt");
  expect(fs.readFileSync(errorFile, "utf8")).toBe(reason);
  expect(fs.statSync(errorFile).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(path.join(artifacts, "shell"))).toBe(false);
});

it("redacts a malformed cleanup input in its retained diagnostic", () => {
  const secret = "hf_aaaaaaaaaa";
  const { artifacts, result } = standaloneCleanup(secret);
  expect(result.status, result.stderr).toBe(1);
  const reason = fs.readFileSync(path.join(artifacts, "cleanup-error.txt"), "utf8");
  expect(reason).toContain("JSON");
  expect(reason).toContain("<REDACTED>");
  expect(reason).not.toContain(secret);
  expect(result.stdout + result.stderr).not.toContain(secret);
});
