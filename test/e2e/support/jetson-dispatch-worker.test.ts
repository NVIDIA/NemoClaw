// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadSshJetsonWorkerConfig,
  ProcessFailure,
  SshJetsonDispatchWorker,
} from "../../../tools/e2e/jetson-dispatch-worker.mts";

const dispatcherRunbook = fs.readFileSync(
  path.join(process.cwd(), "test/e2e/docs/jetson-colossus-dispatch.md"),
  "utf8",
);
const cleanupProgram = fs.readFileSync(
  path.join(process.cwd(), "tools/e2e/jetson-dispatch-cleanup.sh"),
  "utf8",
);
const workerProgram = fs.readFileSync(
  path.join(process.cwd(), "tools/e2e/jetson-dispatch-worker.mts"),
  "utf8",
);
const jetsonLiveTest = fs.readFileSync(
  path.join(process.cwd(), "test/e2e/live/jetson-nvmap-gpu.test.ts"),
  "utf8",
);
const temporaryDirectories: string[] = [];
const BASELINE = {
  nodePath: "/usr/bin/node",
  nodeVersion: "v22.19.0",
  npmPath: "/usr/bin/npm",
  npmVersion: "10.9.3",
  ollamaPath: "/usr/local/bin/ollama",
  ollamaModelsSha256: "a".repeat(64),
  openshellState: "absent",
};

function baselineOutput(overrides: Partial<typeof BASELINE> = {}): string {
  const baseline = { ...BASELINE, ...overrides };
  return `${Object.entries(baseline)
    .map(([key, value]) => `${key}\t${value}`)
    .join("\n")}\n`;
}

const BASELINE_OUTPUT = baselineOutput();

function cleanupOutput({
  volumes = [],
  processIds = [],
}: {
  volumes?: string[];
  processIds?: number[];
} = {}): string {
  return [
    "nemoclaw-cleanup-evidence-v1-begin",
    ...volumes.map((volume) => `volume\t${volume}`),
    ...processIds.map((pid) => `processId\t${pid}`),
    "nemoclaw-cleanup-evidence-v1-end",
    "",
  ].join("\n");
}

function persistCleanupEvidence(
  files: ReturnType<typeof deploymentFiles>,
  jobId: string,
  evidence: { schemaVersion: 1; volumes: string[]; processIds: number[] },
): string {
  const file = path.join(files.stateDirectory, `${jobId}.cleanup.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  return file;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function deploymentFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-jetson-worker-"));
  temporaryDirectories.push(directory);
  const identityFile = path.join(directory, "id_ed25519");
  const knownHostsFile = path.join(directory, "known_hosts");
  const cleanupExecutable = path.join(directory, "cleanup-jetson");
  fs.writeFileSync(identityFile, "test-key", { mode: 0o600 });
  fs.writeFileSync(knownHostsFile, "test-host-key", { mode: 0o600 });
  fs.writeFileSync(cleanupExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { cleanupExecutable, identityFile, knownHostsFile, stateDirectory: directory };
}

function environment(files = deploymentFiles()): NodeJS.ProcessEnv {
  return {
    JETSON_DISPATCH_SSH_DESTINATION: "nvidia@192.168.55.1",
    JETSON_DISPATCH_SSH_IDENTITY_FILE: files.identityFile,
    JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE: files.knownHostsFile,
    JETSON_DISPATCH_CLEANUP_EXECUTABLE: files.cleanupExecutable,
    JETSON_DISPATCH_TEST_TIMEOUT_SECONDS: "2700",
  };
}

function loadConfig(files = deploymentFiles()) {
  return loadSshJetsonWorkerConfig({ stateDirectory: files.stateDirectory }, environment(files));
}

describe("Colossus SSH worker deployment boundary", () => {
  it("uses the fixed deployment command before service startup (#8142)", () => {
    const deployment =
      'sudo /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy \\\n  --commit "$REVIEWED_COMMIT_SHA"';
    expect(dispatcherRunbook).toContain(
      "tools/e2e/colossus-jetson-dispatch-deploy.sh \\\n  /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy",
    );
    expect(dispatcherRunbook).toContain(deployment);
    expect(dispatcherRunbook).toContain("WorkingDirectory=/opt/nemoclaw-jetson-dispatch/current");
    expect(dispatcherRunbook.indexOf(deployment)).toBeLessThan(
      dispatcherRunbook.indexOf("## Configure the Dispatcher Service"),
    );
    expect(dispatcherRunbook).not.toContain("sudo git -C /opt/nemoclaw-jetson-dispatch init");
    expect(dispatcherRunbook).not.toContain("git clone --branch main");
  });

  it("keeps public ingress stopped until a later release passes local verification (#8142)", () => {
    const section = dispatcherRunbook.slice(
      dispatcherRunbook.indexOf("## Deploy a Later Reviewed Commit"),
      dispatcherRunbook.indexOf("## Publish the Dispatcher With Cloudflare Tunnel"),
    );
    const stopTunnel = "sudo systemctl stop nemoclaw-jetson-tunnel.service";
    const deploy = "sudo /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy";
    const startTunnel = "sudo systemctl start nemoclaw-jetson-tunnel.service";
    const publicProof = 'test "$PUBLIC_HTTP_CODE" = 401';

    expect(section).toContain("set -euo pipefail");
    expect(section.indexOf(stopTunnel)).toBeLessThan(section.indexOf(deploy));
    expect(section.indexOf(deploy)).toBeLessThan(section.indexOf(startTunnel));
    expect(section.indexOf(startTunnel)).toBeLessThan(section.indexOf(publicProof));
    expect(section.indexOf(publicProof)).toBeLessThan(section.indexOf("tunnel_verified=1"));
    expect(section).toContain("trap stop_unverified_tunnel EXIT");
    expect(section).toContain("curl --disable --noproxy '*'");
  });

  it.each([
    {
      expectedLog: ["stop", "deploy", "start", "stop"],
      expectedState: "inactive\n",
      failContainmentStop: false,
      name: "stops public ingress when the public proof fails",
    },
    {
      expectedLog: ["stop", "deploy", "start", "stop-failed"],
      expectedState: "active\n",
      failContainmentStop: true,
      name: "reports when public-ingress containment fails",
    },
  ])("$name (#8142)", ({ expectedLog, expectedState, failContainmentStop }) => {
    const section = dispatcherRunbook.slice(
      dispatcherRunbook.indexOf("## Deploy a Later Reviewed Commit"),
      dispatcherRunbook.indexOf("## Publish the Dispatcher With Cloudflare Tunnel"),
    );
    const block = section.match(/```bash\n([\s\S]*?)\n```/u)?.[1];
    expect(block).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tunnel-deploy-test-"));
    temporaryDirectories.push(directory);
    const log = path.join(directory, "service.log");
    const state = path.join(directory, "tunnel.state");
    const stopCount = path.join(directory, "stop.count");
    fs.writeFileSync(state, "active\n");
    fs.writeFileSync(
      path.join(directory, "sudo"),
      `#!/bin/sh
set -eu
case "$1:$2" in
  systemctl:stop)
    count="$(cat "$STOP_COUNT" 2>/dev/null || printf '0')"
    count="$((count + 1))"
    printf '%s\\n' "$count" >"$STOP_COUNT"
    if [ "$FAIL_CONTAINMENT_STOP" = 1 ] && [ "$count" -gt 1 ]; then
      printf 'stop-failed\\n' >>"$SERVICE_LOG"
      exit 5
    fi
    printf 'stop\\n' >>"$SERVICE_LOG"
    printf 'inactive\\n' >"$TUNNEL_STATE"
    ;;
  systemctl:start) printf 'start\\n' >>"$SERVICE_LOG"; printf 'active\\n' >"$TUNNEL_STATE" ;;
  systemctl:show) cat "$TUNNEL_STATE" ;;
  /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy:--commit) printf 'deploy\\n' >>"$SERVICE_LOG" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(directory, "curl"), "#!/bin/sh\nprintf '503'\n", { mode: 0o755 });

    const result = spawnSync("/bin/bash", ["-c", block!], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAIL_CONTAINMENT_STOP: failContainmentStop ? "1" : "0",
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        SERVICE_LOG: log,
        STOP_COUNT: stopCount,
        TUNNEL_STATE: state,
      },
    });

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(expectedLog);
    expect(fs.readFileSync(state, "utf8")).toBe(expectedState);
    if (failContainmentStop) {
      expect(result.stderr).toContain(
        "PUBLIC INGRESS CONTAINMENT FAILED: tunnel stop status=5; ActiveState=active",
      );
    } else {
      expect(result.stderr).not.toContain("PUBLIC INGRESS CONTAINMENT FAILED");
    }
  });

  it("loads fixed SSH, host-key, timeout, and cleanup configuration (#8142)", () => {
    const files = deploymentFiles();
    expect(loadConfig(files)).toEqual({
      cleanupExecutable: files.cleanupExecutable,
      destination: "nvidia@192.168.55.1",
      identityFile: files.identityFile,
      knownHostsFile: files.knownHostsFile,
      stateDirectory: files.stateDirectory,
      testTimeoutSeconds: 2700,
    });
  });

  it("collects a bounded artifact archive before the remote workspace is removed (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const baselinePath = path.join(files.stateDirectory, `${jobId}.baseline.json`);
    fs.writeFileSync(baselinePath, `${JSON.stringify({ ...BASELINE, nodeVersion: "v22.0.0" })}\n`, {
      mode: 0o600,
    });
    const artifactArchiveBase64 = Buffer.from("remote archive").toString("base64");
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "test passed\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: artifactArchiveBase64, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.run(
        {
          schemaVersion: 1,
          target: "jetson-nvmap-gpu",
          candidateSha: "a".repeat(40),
          workflowRunId: "123",
          workflowRunAttempt: 1,
        },
        { jobId, signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      artifactArchiveBase64,
      log: expect.stringContaining("test passed"),
    });
    expect(processRunner.mock.calls[0]![0].input).toContain(
      "major < 22 || (major === 22 && minor < 19)",
    );
    expect(processRunner.mock.calls[0]![0].input).toContain("npm_major >= 10");
    expect(processRunner.mock.calls[2]![0].input).toContain(
      "major < 22 || (major === 22 && minor < 19)",
    );
    expect(processRunner.mock.calls[2]![0].input).toContain("npm_major >= 10");
    expect(JSON.parse(fs.readFileSync(baselinePath, "utf8"))).toEqual(BASELINE);
    expect(processRunner.mock.calls[2]![0].input).not.toContain("trap cleanup EXIT");
    expect(processRunner.mock.calls[3]![0].input).not.toContain("trap cleanup EXIT");
    expect(processRunner.mock.calls[3]![0].input).toContain("base64 --wrap=0");
  });

  it("preserves test-failure logs when artifact collection fails (#8142)", async () => {
    const files = deploymentFiles();
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockRejectedValueOnce(
        new ProcessFailure("Jetson test failed", {
          stdout: "failed test output\n",
          stderr: "failed test error\n",
        }),
      )
      .mockRejectedValueOnce(new Error("artifact collection unavailable"));
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.run(
        {
          schemaVersion: 1,
          target: "jetson-nvmap-gpu",
          candidateSha: "a".repeat(40),
          workflowRunId: "123",
          workflowRunAttempt: 1,
        },
        { jobId: "b".repeat(64), signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      message: "Jetson test failed; artifact collection failed: artifact collection unavailable",
      log: expect.stringContaining("failed test output"),
    });
  });

  it("preserves successful test logs when artifact collection fails (#8142)", async () => {
    const files = deploymentFiles();
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "successful test output\n", stderr: "" })
      .mockRejectedValueOnce(new Error("artifact collection unavailable"));
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.run(
        {
          schemaVersion: 1,
          target: "jetson-nvmap-gpu",
          candidateSha: "a".repeat(40),
          workflowRunId: "123",
          workflowRunAttempt: 1,
        },
        { jobId: "b".repeat(64), signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      message: "artifact collection unavailable",
      log: expect.stringContaining("successful test output"),
    });
  });

  it.each([
    "nvidia@192.168.55.2",
    "nvidia@192.168.55.1 -o StrictHostKeyChecking=no",
    "nvidia@host;uname",
    "root@",
    "-oProxyCommand=unsafe",
  ])("rejects an SSH destination that is not the fixed Jetson user and host: %s (#8142)", (destination) => {
    const files = deploymentFiles();
    expect(() =>
      loadSshJetsonWorkerConfig(
        { stateDirectory: files.stateDirectory },
        {
          ...environment(files),
          JETSON_DISPATCH_SSH_DESTINATION: destination,
        },
      ),
    ).toThrow("JETSON_DISPATCH_SSH_DESTINATION must be nvidia@192.168.55.1");
  });

  it("rejects a writable SSH identity file (#8142)", () => {
    const files = deploymentFiles();
    fs.chmodSync(files.identityFile, 0o666);
    expect(() => loadConfig(files)).toThrow("must not be group- or world-writable");
  });

  it("rejects a group-readable SSH identity file (#8142)", () => {
    const files = deploymentFiles();
    fs.chmodSync(files.identityFile, 0o640);
    expect(() => loadConfig(files)).toThrow("must be readable only by its owner");
  });

  it("rejects a symbolic-link cleanup executable (#8142)", () => {
    const files = deploymentFiles();
    const link = path.join(path.dirname(files.cleanupExecutable), "cleanup-link");
    fs.symlinkSync(files.cleanupExecutable, link);
    expect(() =>
      loadSshJetsonWorkerConfig(
        { stateDirectory: files.stateDirectory },
        {
          ...environment(files),
          JETSON_DISPATCH_CLEANUP_EXECUTABLE: link,
        },
      ),
    ).toThrow("must be a regular file");
  });

  it("accepts only the exact root-owned current-release cleanup link (#8142)", () => {
    const files = deploymentFiles();
    const cleanupExecutable = "/usr/local/libexec/nemoclaw-jetson-cleanup";
    const cleanupTarget =
      "/opt/nemoclaw-jetson-dispatch/current/tools/e2e/jetson-dispatch-cleanup.sh";
    const localLink = path.join(files.stateDirectory, "managed-cleanup-link");
    fs.symlinkSync(files.cleanupExecutable, localLink);
    const realLstatSync = fs.lstatSync.bind(fs);
    const realReadlinkSync = fs.readlinkSync.bind(fs);
    const localLinkStat = realLstatSync(localLink);
    const rootLinkStat = Object.assign(
      Object.create(Object.getPrototypeOf(localLinkStat)),
      localLinkStat,
      { uid: 0 },
    ) as fs.Stats;
    const nonRootLinkStat = Object.assign(
      Object.create(Object.getPrototypeOf(localLinkStat)),
      localLinkStat,
      { uid: 1000 },
    ) as fs.Stats;
    const secureTargetStat = realLstatSync(files.cleanupExecutable);
    const unsafeTargetStat = Object.assign(
      Object.create(Object.getPrototypeOf(secureTargetStat)),
      secureTargetStat,
      { mode: secureTargetStat.mode | 0o022 },
    ) as fs.Stats;
    let selectedTarget = "/tmp/unmanaged-cleanup";
    let managedLinkStat = rootLinkStat;
    let managedTargetStat = secureTargetStat;
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation((candidate, options) => {
      if (String(candidate) === cleanupExecutable) return managedLinkStat;
      if (String(candidate) === cleanupTarget) return managedTargetStat;
      return realLstatSync(candidate, options as never);
    });
    const readlink = vi
      .spyOn(fs, "readlinkSync")
      .mockImplementation(((candidate, options) =>
        String(candidate) === cleanupExecutable
          ? selectedTarget
          : realReadlinkSync(candidate, options as never)) as typeof fs.readlinkSync);

    try {
      const env = {
        ...environment(files),
        JETSON_DISPATCH_CLEANUP_EXECUTABLE: cleanupExecutable,
      };
      expect(() =>
        loadSshJetsonWorkerConfig({ stateDirectory: files.stateDirectory }, env),
      ).toThrow("must select the managed current-release cleanup program");

      selectedTarget = cleanupTarget;
      managedLinkStat = nonRootLinkStat;
      expect(() =>
        loadSshJetsonWorkerConfig({ stateDirectory: files.stateDirectory }, env),
      ).toThrow("symbolic link must be owned by root");

      managedLinkStat = rootLinkStat;
      managedTargetStat = unsafeTargetStat;
      expect(() =>
        loadSshJetsonWorkerConfig({ stateDirectory: files.stateDirectory }, env),
      ).toThrow("must not be group- or world-writable");

      managedTargetStat = secureTargetStat;
      expect(
        loadSshJetsonWorkerConfig({ stateDirectory: files.stateDirectory }, env),
      ).toMatchObject({ cleanupExecutable });
    } finally {
      readlink.mockRestore();
      lstat.mockRestore();
    }
  });

  it("invokes the fixed cleanup executable without request-controlled arguments (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const baselinePath = path.join(files.stateDirectory, `${jobId}.baseline.json`);
    fs.writeFileSync(baselinePath, `${JSON.stringify(BASELINE)}\n`, { mode: 0o600 });
    persistCleanupEvidence(files, jobId, {
      schemaVersion: 1,
      volumes: ["sandbox-volume"],
      processIds: [1234],
    });
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: cleanupOutput({ volumes: ["sandbox-volume"], processIds: [1234] }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.cleanup({ jobId, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();

    expect(processRunner.mock.calls[0]![0]).toMatchObject({
      args: [],
      executable: files.cleanupExecutable,
    });
    expect(processRunner.mock.calls[0]![0].input).toBeUndefined();
    expect(processRunner.mock.calls[1]![0]).toMatchObject({
      executable: "ssh",
      input: expect.stringContaining('workspace="/var/tmp/nemoclaw-jetson-e2e/$job_id"'),
    });
    expect(processRunner.mock.calls[1]![0].input).toContain("docker info --format");
    expect(processRunner.mock.calls[1]![0].input).toContain("test -c /dev/nvmap");
    expect(processRunner.mock.calls[1]![0].input).toContain("ollama list");
    expect(processRunner.mock.calls[1]![0].input).toContain(
      'for volume in "${recorded_volumes[@]}"',
    );
    expect(processRunner.mock.calls[1]![0].input).toContain(
      'for pid in "${recorded_process_ids[@]}"',
    );
    expect(processRunner.mock.calls[1]![0].input).toContain("docker container ls --all --no-trunc");
    expect(processRunner.mock.calls[1]![0].input).toContain(
      "docker volume ls --format '{{.Name}}'",
    );
    expect(processRunner.mock.calls[1]![0].input).not.toContain("docker container inspect");
    expect(processRunner.mock.calls[1]![0].input).not.toContain("docker volume inspect");
    expect(processRunner.mock.calls[1]![0].args).toEqual(
      expect.arrayContaining(["nvidia@192.168.55.1", "--", jobId]),
    );
    const encodedEvidence = processRunner.mock.calls[1]![0].args.at(-1);
    expect(JSON.parse(Buffer.from(encodedEvidence!, "base64").toString("utf8"))).toEqual({
      schemaVersion: 1,
      volumes: ["sandbox-volume"],
      processIds: [1234],
    });
    expect(fs.existsSync(baselinePath)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(files.stateDirectory, `${jobId}.cleanup.json`), "utf8")),
    ).toEqual({ schemaVersion: 1, volumes: ["sandbox-volume"], processIds: [1234] });
    expect(fs.statSync(path.join(files.stateDirectory, `${jobId}.cleanup.json`)).mode & 0o777).toBe(
      0o600,
    );
  });

  it("verifies cleanup after a pre-candidate failure without a baseline record (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    persistCleanupEvidence(files, jobId, { schemaVersion: 1, volumes: [], processIds: [] });
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: cleanupOutput(), stderr: "" })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.cleanup({ jobId, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();

    expect(processRunner).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(files.stateDirectory, `${jobId}.baseline.json`))).toBe(false);
  });

  it.each([
    ["Node.js", { nodeVersion: "v22.20.0" }],
    ["npm", { npmVersion: "11.0.0" }],
    ["Ollama executable", { ollamaPath: "/tmp/ollama" }],
    ["Ollama models", { ollamaModelsSha256: "c".repeat(64) }],
  ])("rejects cleanup when the protected %s baseline changes (#8142)", async (_name, change) => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const baselinePath = path.join(files.stateDirectory, `${jobId}.baseline.json`);
    fs.writeFileSync(baselinePath, `${JSON.stringify(BASELINE)}\n`, { mode: 0o600 });
    persistCleanupEvidence(files, jobId, { schemaVersion: 1, volumes: [], processIds: [] });
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: cleanupOutput(), stderr: "" })
      .mockResolvedValueOnce({ stdout: baselineOutput(change), stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(worker.cleanup({ jobId, signal: new AbortController().signal })).rejects.toThrow(
      "Jetson protected tool or Ollama model baseline differs after cleanup",
    );
    expect(fs.existsSync(baselinePath)).toBe(true);
  });

  it("rejects cleanup unless OpenShell returns to the absent baseline (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    fs.writeFileSync(
      path.join(files.stateDirectory, `${jobId}.baseline.json`),
      `${JSON.stringify(BASELINE)}\n`,
      { mode: 0o600 },
    );
    persistCleanupEvidence(files, jobId, { schemaVersion: 1, volumes: [], processIds: [] });
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: cleanupOutput(), stderr: "" })
      .mockResolvedValueOnce({ stdout: baselineOutput({ openshellState: "present" }), stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(worker.cleanup({ jobId, signal: new AbortController().signal })).rejects.toThrow(
      "Jetson protected-baseline OpenShell state is malformed",
    );
  });

  it("retains every validated cleanup identity across stale-lock recovery (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    fs.writeFileSync(
      path.join(files.stateDirectory, `${jobId}.baseline.json`),
      `${JSON.stringify(BASELINE)}\n`,
      { mode: 0o600 },
    );
    const processRunner = vi
      .fn()
      .mockImplementationOnce(async () => {
        persistCleanupEvidence(files, jobId, {
          schemaVersion: 1,
          volumes: ["sandbox-volume"],
          processIds: [1234],
        });
        return {
          stdout: cleanupOutput({ volumes: ["sandbox-volume"], processIds: [1234] }),
          stderr: "",
        };
      })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockImplementationOnce(async () => {
        persistCleanupEvidence(files, jobId, {
          schemaVersion: 1,
          volumes: ["gateway-volume", "sandbox-volume"],
          processIds: [1234, 5678],
        });
        return {
          stdout: cleanupOutput({
            volumes: ["gateway-volume", "sandbox-volume"],
            processIds: [1234, 5678],
          }),
          stderr: "",
        };
      })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await worker.cleanup({ jobId, signal: new AbortController().signal });
    await worker.cleanup({ jobId, signal: new AbortController().signal });

    expect(
      JSON.parse(fs.readFileSync(path.join(files.stateDirectory, `${jobId}.cleanup.json`), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      volumes: ["gateway-volume", "sandbox-volume"],
      processIds: [1234, 5678],
    });
  });

  it("retains a failed volume identity for startup cleanup recovery (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const cleanupEvidencePath = path.join(files.stateDirectory, `${jobId}.cleanup.json`);
    fs.writeFileSync(
      path.join(files.stateDirectory, `${jobId}.baseline.json`),
      `${JSON.stringify(BASELINE)}\n`,
      { mode: 0o600 },
    );
    const processRunner = vi
      .fn()
      .mockImplementationOnce(async () => {
        persistCleanupEvidence(files, jobId, {
          schemaVersion: 1,
          volumes: ["sandbox-volume"],
          processIds: [],
        });
        throw new ProcessFailure("cleanup interrupted after container removal", {
          stdout: "container removed\n",
          stderr: "service interrupted\n",
        });
      })
      .mockResolvedValueOnce({
        stdout: cleanupOutput({ volumes: ["sandbox-volume"] }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(worker.cleanup({ jobId, signal: new AbortController().signal })).rejects.toThrow(
      "cleanup interrupted after container removal",
    );
    expect(JSON.parse(fs.readFileSync(cleanupEvidencePath, "utf8"))).toEqual({
      schemaVersion: 1,
      volumes: ["sandbox-volume"],
      processIds: [],
    });

    const restartedWorker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);
    await expect(
      restartedWorker.cleanup({ jobId, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();
    const encodedEvidence = processRunner.mock.calls[2]![0].args.at(-1);
    expect(JSON.parse(Buffer.from(encodedEvidence!, "base64").toString("utf8"))).toEqual({
      schemaVersion: 1,
      volumes: ["sandbox-volume"],
      processIds: [],
    });
  });

  it.each([
    "",
    "nemoclaw-cleanup-evidence-v1-begin\nvolume\t../unsafe\nnemoclaw-cleanup-evidence-v1-end\n",
    "nemoclaw-cleanup-evidence-v1-begin\nprocessId\t0\nnemoclaw-cleanup-evidence-v1-end\n",
  ])("rejects missing or unsafe cleanup identity evidence (#8142)", async (stdout) => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const processRunner = vi.fn().mockResolvedValueOnce({ stdout, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(worker.cleanup({ jobId, signal: new AbortController().signal })).rejects.toThrow(
      /Jetson cleanup/u,
    );
    expect(processRunner).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(files.stateDirectory, `${jobId}.cleanup.json`))).toBe(false);
  });

  it("rejects cleanup output that differs from the durable identity record (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    persistCleanupEvidence(files, jobId, { schemaVersion: 1, volumes: [], processIds: [] });
    const processRunner = vi.fn().mockResolvedValueOnce({
      stdout: cleanupOutput({ volumes: ["unpersisted-volume"] }),
      stderr: "",
    });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(worker.cleanup({ jobId, signal: new AbortController().signal })).rejects.toThrow(
      "Jetson cleanup output differs from its durable resource evidence",
    );
    expect(processRunner).toHaveBeenCalledTimes(1);
  });

  it("reports a missing durable cleanup record after valid helper output (#8142)", async () => {
    const files = deploymentFiles();
    const worker = new SshJetsonDispatchWorker(
      loadConfig(files),
      vi.fn().mockResolvedValueOnce({ stdout: cleanupOutput(), stderr: "" }),
    );

    await expect(
      worker.cleanup({ jobId: "b".repeat(64), signal: new AbortController().signal }),
    ).rejects.toThrow("Jetson cleanup evidence is missing");
  });

  it("keeps cleanup targets fixed and preserves the Jetson baseline (#8142)", () => {
    const fileFsync = cleanupProgram.indexOf("fs.fsyncSync(descriptor)");
    const atomicRename = cleanupProgram.indexOf("fs.renameSync(temporaryFile, cleanupFile)");
    const directoryFsync = cleanupProgram.indexOf("fs.fsyncSync(directoryDescriptor)");
    const destructivePhase = cleanupProgram.indexOf("<<'JETSON_CLEANUP'");
    expect(cleanupProgram).toContain("sandbox_name=e2e-jetson-nvmap");
    expect(cleanupProgram).toContain("gateway_container=openshell-cluster-nemoclaw");
    expect(cleanupProgram).toContain("destination=nvidia@192.168.55.1");
    expect(cleanupProgram).toContain('if [ "$#" -ne 0 ]');
    expect(cleanupProgram).toContain('mapfile -t lock_lines <"$lock_file"');
    expect(cleanupProgram).toContain('[ "${#lock_lines[@]}" -ne 1 ]');
    expect(cleanupProgram).toContain('require_plain_directory_if_present "$service_directory"');
    expect(cleanupProgram).toContain('rm -rf -- "$workspace"');
    expect(cleanupProgram).toContain("ollama-auth-proxy.pid");
    expect(cleanupProgram).toContain('process_uid="$(awk');
    expect(cleanupProgram).toContain('grep -Fqx "HOME=$job_home"');
    expect(cleanupProgram).toContain("*openshell-forward*");
    expect(cleanupProgram).toContain("*openshell\\ forward*");
    expect(cleanupProgram).toContain('kill "$pid"');
    expect(cleanupProgram).toContain("label=openshell.ai/sandbox-name=$sandbox_name");
    expect(cleanupProgram).toContain("image_repository=nemoclaw-sandbox-local");
    expect(cleanupProgram).toContain('docker image rm "$image"');
    expect(cleanupProgram.indexOf('docker image rm "$image"')).toBeLessThan(
      cleanupProgram.indexOf('rm -rf -- "$workspace"'),
    );
    expect(cleanupProgram).not.toContain("job_openshell");
    expect(cleanupProgram).not.toContain('"$job_home/.local/bin/openshell"');
    expect(cleanupProgram).toContain("docker container ls --all --no-trunc");
    expect(cleanupProgram).toContain("docker volume ls --format '{{.Name}}'");
    expect(cleanupProgram).not.toMatch(/if docker (?:container|volume) inspect/u);
    expect(cleanupProgram).not.toContain("mapfile -t sandbox_containers < <(");
    expect(cleanupProgram).toContain("A host-level OpenShell binary remains after cleanup");
    expect(cleanupProgram).toContain("nemoclaw-cleanup-evidence-v1-begin");
    expect(cleanupProgram).toContain("nemoclaw-cleanup-evidence-v1-end");
    expect(cleanupProgram.indexOf("nemoclaw-cleanup-evidence-v1-begin")).toBeLessThan(
      cleanupProgram.indexOf('docker container rm --force "$container"'),
    );
    expect(cleanupProgram.indexOf("nemoclaw-cleanup-evidence-v1-end")).toBeLessThan(
      cleanupProgram.indexOf('docker volume rm "$volume"'),
    );
    expect(cleanupProgram).toContain("fs.constants.O_EXCL");
    expect(fileFsync).toBeGreaterThan(cleanupProgram.indexOf("<<'JETSON_DISCOVERY'"));
    expect(atomicRename).toBeGreaterThan(fileFsync);
    expect(directoryFsync).toBeGreaterThan(atomicRename);
    expect(destructivePhase).toBeGreaterThan(directoryFsync);
    expect(cleanupProgram).not.toMatch(/pkill|pgrep|docker (?:system|container|volume) prune/u);
    expect(cleanupProgram).not.toContain('rm -rf -- "$workspace_root"');
    expect(cleanupProgram).not.toContain("ollama serve");
    expect(cleanupProgram).not.toMatch(/apt(?:-get)?|boardctl|reboot|shutdown|nvidia-l4t/u);
    expect(cleanupProgram).not.toMatch(/npm uninstall|uninstall\.sh|rm .*ollama/u);
  });

  it("keeps OpenShell installation owned by NemoClaw onboarding inside the job workspace (#8142)", () => {
    expect(workerProgram).not.toContain("NEMOCLAW_DEFER_OPENSHELL_INSTALL");
    expect(jetsonLiveTest).not.toContain("NEMOCLAW_DEFER_OPENSHELL_INSTALL");
    expect(workerProgram).not.toContain("scripts/install-openshell.sh");
    expect(cleanupProgram).not.toContain("scripts/install-openshell.sh");
    expect(jetsonLiveTest).not.toContain("scripts/install-openshell.sh");
    expect(jetsonLiveTest).toContain('host.command("bash", ["install.sh", "--non-interactive"]');
    expect(workerProgram).toContain('export XDG_BIN_HOME="$workspace/home/.local/bin"');
    expect(workerProgram).toContain('export PATH="$XDG_BIN_HOME:$workspace/npm-prefix/bin:$PATH"');
    expect(workerProgram).toContain(
      "for installed_command in nemoclaw openshell openshell-gateway openshell-sandbox",
    );
    expect(jetsonLiveTest).toContain(
      "for installed_command in nemoclaw openshell openshell-gateway openshell-sandbox",
    );
    expect(cleanupProgram.indexOf('stop_recorded_pid "$pid"')).toBeLessThan(
      cleanupProgram.indexOf('docker container rm --force "$container"'),
    );
    expect(cleanupProgram.indexOf('docker container rm --force "$container"')).toBeLessThan(
      cleanupProgram.indexOf('rm -rf -- "$workspace"'),
    );
  });

  it("requires every protected Jetson prerequisite before dispatch (#8142)", () => {
    expect(dispatcherRunbook).toContain("OpenShell must be absent");
    expect(dispatcherRunbook).toContain(
      "if (major < 22 || (major === 22 && minor < 19)) process.exit(1)",
    );
    expect(dispatcherRunbook).toContain('test "${npm_version%%.*}" -ge 10');
    expect(dispatcherRunbook).toContain("ollama list");
  });

  it("keeps recovery credentials until idle teardown verification succeeds (#8142)", () => {
    const stopTunnel = dispatcherRunbook.indexOf(
      "sudo systemctl disable --now nemoclaw-jetson-tunnel.service",
    );
    const waitForLock = dispatcherRunbook.indexOf(
      "timeout 3600 bash -c 'while [ -e \"$1\" ]; do sleep 5; done'",
    );
    const verifyCleanup = dispatcherRunbook.indexOf(
      'if (status.state !== "completed" || status.cleanup !== "succeeded") process.exit(1)',
    );
    const aggregateCleanupRecords = dispatcherRunbook.indexOf(
      "const cleanupName = /^[a-f0-9]{64}\\.cleanup\\.json$/",
    );
    const verifyRecordedVolume = dispatcherRunbook.indexOf("docker volume ls --format '{{.Name}}'");
    const verifyRecordedProcess = dispatcherRunbook.indexOf('if [ -e "/proc/$1" ]');
    const stopDispatcher = dispatcherRunbook.indexOf(
      "sudo systemctl disable --now nemoclaw-jetson-dispatch.service",
    );
    const removeSshKey = dispatcherRunbook.indexOf(
      "Remove the dedicated Jetson public key and the Colossus SSH private key.",
    );

    expect(dispatcherRunbook).toContain("TimeoutStopSec=360");
    expect(stopTunnel).toBeGreaterThan(-1);
    expect(waitForLock).toBeGreaterThan(stopTunnel);
    expect(verifyCleanup).toBeGreaterThan(waitForLock);
    expect(dispatcherRunbook).toContain(
      'const expectedKeys = ["processIds", "schemaVersion", "volumes"]',
    );
    expect(dispatcherRunbook).toContain("record.schemaVersion !== 1");
    expect(aggregateCleanupRecords).toBeGreaterThan(verifyCleanup);
    expect(verifyRecordedVolume).toBeGreaterThan(aggregateCleanupRecords);
    expect(verifyRecordedProcess).toBeGreaterThan(verifyRecordedVolume);
    expect(stopDispatcher).toBeGreaterThan(verifyRecordedProcess);
    expect(removeSshKey).toBeGreaterThan(stopDispatcher);
  });
});
