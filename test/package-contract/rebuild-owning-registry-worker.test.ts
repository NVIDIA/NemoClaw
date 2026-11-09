// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { rebuildOwningRegistryDependencies } from "../../dist/lib/actions/sandbox/rebuild/owning-registry";
import { withSandboxLifecycleLock } from "../../dist/lib/actions/sandbox/lifecycle/lock";
import { execTimeout, testTimeout } from "../helpers/timeouts";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-09-17T00-00-00-000Z";
const WORKER_FIXTURE_TIMEOUT_MS = execTimeout(20_000);
vi.setConfig({ testTimeout: testTimeout(WORKER_FIXTURE_TIMEOUT_MS + 5_000) });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function startWorkerWithControlledDeadline(start: () => Promise<void>) {
  const deadlines = vi.spyOn(globalThis, "setTimeout");
  try {
    const worker = start();
    const deadline = deadlines.mock.calls.find(([, delay]) => delay === WORKER_FIXTURE_TIMEOUT_MS);
    assert(deadline, "The worker fixture did not schedule its deadline.");
    return { worker, expire: () => deadline[0]() };
  } finally {
    deadlines.mockRestore();
  }
}

function writeRecoveryFixture(home: string) {
  const backupPath = path.join(
    home,
    ".nemoclaw",
    "gateways",
    "9000",
    "rebuild-backups",
    "alpha",
    TIMESTAMP,
  );
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  const policy = "version: 1\nprocess:\n  environment:\n    SERVICE_API_KEY: retained\n";
  const sha256 = createHash("sha256").update(policy).digest("hex");
  const handoffPath = path.join(backupPath, `rebuild-policy-handoff.${sha256}.yaml`);
  fs.writeFileSync(handoffPath, policy, { mode: 0o600 });
  const archivePath = path.join(backupPath, "native-home.tar");
  const tar = spawnSync("tar", ["-cf", archivePath, "--files-from", "/dev/null"]);
  assert.equal(tar.status, 0, "Could not create native-state recovery fixture");
  const archiveSha256 = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  const manifest = {
    version: 2,
    sandboxName: "alpha",
    timestamp: TIMESTAMP,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    nativeState: {
      root: "/sandbox",
      archive: "native-home.tar" as const,
      sha256: archiveSha256,
    },
    backupPath,
    blueprintDigest: null,
    rebuildPolicyHandoff: { file: path.basename(handoffPath), sha256 },
  };
  fs.writeFileSync(path.join(backupPath, "rebuild-manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(backupPath, ".nemoclaw-rebuild-recovery.json"),
    `${JSON.stringify({
      schemaVersion: 3,
      transactionId: TRANSACTION_ID,
      sandboxName: "alpha",
      backupTimestamp: TIMESTAMP,
      gatewayName: "nemoclaw-9000",
      gatewayPort: 9000,
      phase: "restore",
    })}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

function writeBlockingOpenShell(home: string, descendantMarker: string): string {
  const executable = path.join(home, "blocking-openshell.cjs");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `fs.writeFileSync(${JSON.stringify(descendantMarker)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function writeCredentialProbeOpenShell(home: string, marker: string): string {
  const executable = path.join(home, "credential-probe-openshell.cjs");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(marker)}, String(process.ppid));`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function writeMissingSandboxOpenShell(home: string): string {
  const executable = path.join(home, "missing-sandbox-openshell.cjs");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "sandbox" && process.argv[3] === "get") {',
      '  console.error("no such sandbox alpha");',
      "}",
      "process.exitCode = 1;",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function writeSiblingRegistry(
  home: string,
  entryOverrides: Readonly<Record<string, unknown>> = {},
  gatewayPort = 9000,
): void {
  const stateRoot = path.join(home, ".nemoclaw", "gateways", String(gatewayPort));
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    `${JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          provider: "ollama-local",
          model: "nvidia/nemotron",
          agent: "openclaw",
          dashboardPort: 18_789,
          gatewayName: `nemoclaw-${String(gatewayPort)}`,
          gatewayPort,
          ...entryOverrides,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
}

function writeTimeoutPreflightRuntime(
  home: string,
  callsFile: string,
  owningGatewayPort: number,
  dashboardPort: number,
) {
  const imageId = `sha256:${"a".repeat(64)}`;
  const image = `example.test/openclaw@${imageId}`;
  const platform = `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const inspect = {
    Id: imageId,
    Os: "linux",
    Architecture: platform.split("/")[1],
    Config: {
      User: "sandbox",
      WorkingDir: "/sandbox",
      Entrypoint: ["openclaw"],
      Cmd: [],
      Env: ["NEMOCLAW_AGENT=openclaw", "NEMOCLAW_TOOL_DISCLOSURE=progressive"],
    },
  };
  const executable = path.join(home, "openshell");
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "// request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      `const gatewayPort = ${String(owningGatewayPort)};`,
      "const tool = path.basename(process.argv[1]);",
      `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ tool, args, gateway: process.env.OPENSHELL_GATEWAY }) + "\\n");`,
      'if (["brew", "curl"].includes(tool)) { console.error("Unexpected host tool: " + tool); process.exit(1); }',
      'const command = args.filter((arg, i) => !["--gateway", "-g"].includes(arg) && !["--gateway", "-g"].includes(args[i - 1]));',
      'const key = command.slice(0, 2).join(" ");',
      `const image = ${JSON.stringify(inspect)};`,
      'if (tool === "docker") {',
      '  if (command[0] === "run" && command.at(-1) === "true") process.exit(0);',
      `  if (command[0] === "run" && command.includes("nslookup")) { console.error("Server: 192.0.2.53\\n** server can't find " + command.at(-1) + ": NXDOMAIN"); process.exit(1); }`,
      "  const responses = {",
      '    "info --format": { ServerVersion: "29.2.1", Driver: "overlay2", OSType: "linux", OperatingSystem: process.platform === "darwin" ? "Docker Desktop" : "Ubuntu 24.04", Architecture: image.Architecture, NCPU: 4, MemTotal: 34359738368, Runtimes: { runc: {} } },',
      '    "version --format": { Client: { Version: "29.2.1" }, Server: { Version: "29.2.1", Os: "linux", Arch: image.Architecture } },',
      '    "image inspect": [image],',
      '    "ps --format": "",',
      '    "ps -a": "",',
      '    "context show": "default",',
      "  };",
      '  if (command[0] === "inspect" && command.includes("--format")) {',
      '    const format = command[command.indexOf("--format") + 1];',
      '    console.log(format === "{{.State.Running}}" ? "true" : format.includes("Ports") ? JSON.stringify({ "8080/tcp": [{ HostPort: String(gatewayPort) }] }) : format.includes("Image") ? "openshell/cluster:0.0.116" : "{}");',
      "  } else if (key in responses) {",
      '    console.log(typeof responses[key] === "string" ? responses[key] : JSON.stringify(responses[key]));',
      '  } else { console.error("Unexpected Docker fixture request: " + JSON.stringify(command)); process.exitCode = 1; }',
      '} else if (command[0] === "--version" || command[0] === "-V") {',
      '  console.log("openshell 0.0.116");',
      '} else if (command[0] === "status") {',
      "  console.log(`Gateway: nemoclaw-${gatewayPort}\\nStatus: Connected\\nServer: https://127.0.0.1:${gatewayPort}/`);",
      '} else if (key === "gateway list") {',
      "  console.log(JSON.stringify([{ name: `nemoclaw-${gatewayPort}`, endpoint: `https://127.0.0.1:${gatewayPort}`, active: true }]));",
      '} else if (key === "gateway info") {',
      "  console.log(`Gateway: nemoclaw-${gatewayPort}\\nGateway endpoint: https://127.0.0.1:${gatewayPort}`);",
      '} else if (key === "forward list") {',
      '  console.error("No active forwards.");',
      '} else if (key === "provider get") {',
      '  console.log("Name: compatible-endpoint\\nType: openai\\nCredential keys: COMPATIBLE_API_KEY\\nConfig keys: OPENAI_BASE_URL");',
      '} else if (key === "provider list") {',
      '  console.log(JSON.stringify([{ name: "compatible-endpoint", credential_keys: ["COMPATIBLE_API_KEY"] }]));',
      '} else if (key === "sandbox get") {',
      '  console.log(JSON.stringify({ name: "alpha", id: "sandbox-alpha", phase: "Ready" }));',
      '} else if (key === "sandbox list") {',
      '  console.log(JSON.stringify({ sandboxes: [{ name: "alpha", id: "sandbox-alpha", phase: "Ready" }] }));',
      '} else if (key === "inference get") {',
      '  console.log("Provider: compatible-endpoint\\nModel: test/model");',
      '} else { console.error("Unexpected OpenShell fixture request: " + JSON.stringify(command)); process.exitCode = 1; }',
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.symlinkSync(executable, path.join(home, "docker"));
  fs.symlinkSync(executable, path.join(home, "brew"));
  fs.symlinkSync(executable, path.join(home, "curl"));
  writeSiblingRegistry(
    home,
    {
      provider: "compatible-endpoint",
      model: "test/model",
      endpointUrl: "http://localhost:11434/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      dashboardPort,
      sandboxGpuMode: "0",
      toolDisclosure: "progressive",
      openshellDriver: "docker",
      workload: {
        schemaVersion: 1,
        kind: "external-image",
        reference: image,
        platform,
        runtimeImageContentId: imageId,
        shared: true,
      },
    },
    owningGatewayPort,
  );
  return executable;
}

describe("compiled rebuild owning-registry worker", () => {
  it("rejects a delegated shared-route timeout before backup or source deletion", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-timeout-"));
    const callsFile = path.join(home, "calls.jsonl");
    const gateway = net.createServer((socket) => socket.end());
    try {
      await new Promise<void>((resolve, reject) => {
        gateway.once("error", reject);
        gateway.listen(0, "127.0.0.1", resolve);
      });
      const gatewayPort = (gateway.address() as AddressInfo).port;
      const dashboard = net.createServer();
      await new Promise<void>((resolve) => dashboard.listen(0, "127.0.0.1", resolve));
      const dashboardPort = (dashboard.address() as AddressInfo).port;
      await new Promise<void>((resolve) => dashboard.close(() => resolve()));
      const executable = writeTimeoutPreflightRuntime(home, callsFile, gatewayPort, dashboardPort);
      const stateDir = path.join(home, ".nemoclaw", "gateways", String(gatewayPort));
      const registryFile = path.join(stateDir, "sandboxes.json");
      const beforeRegistry = fs.readFileSync(registryFile, "utf8");
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", `${home}${path.delimiter}${process.env.PATH}`);
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", executable);
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_BIN", executable);
      vi.stubEnv("NEMOCLAW_OPENSHELL_SANDBOX_BIN", executable);
      vi.stubEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE", "1");
      vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "3601");
      vi.stubEnv("COMPATIBLE_API_KEY", "");
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${String(gatewayPort)}`);
      const message = "NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds";

      const failure = await rebuildOwningRegistryDependencies
        .runWorker(
          {
            operation: "rebuild",
            sandboxName: "alpha",
            options: { yes: true },
            executionOptions: {},
          },
          gatewayPort,
          { timeoutMs: WORKER_FIXTURE_TIMEOUT_MS },
        )
        .catch((error: unknown) => error);
      const calls = fs.readFileSync(callsFile, "utf8");
      expect(failure, calls).toMatchObject({
        message: expect.stringContaining(message),
        cause: expect.objectContaining({
          ok: false,
          operation: "rebuild",
          sandboxName: "alpha",
          gatewayPort,
          message: expect.stringContaining(message),
        }),
      });
      expect(calls).not.toMatch(/"delete"|native-home\.tar|rebuild-backups/);
      expect(fs.existsSync(path.join(stateDir, "rebuild-backups"))).toBe(false);
      expect(fs.readFileSync(registryFile, "utf8")).toBe(beforeRegistry);
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("executes the real pipeline and preserves its bounded failure", async () => {
    const expectedMessage = "toolDisclosure must be one of: progressive, direct.";
    let failure: unknown;

    try {
      await rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: { yes: true, toolDisclosure: "invalid" } as never,
          executionOptions: {},
        },
        9000,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expectedMessage);
    expect((failure as Error).cause).toEqual({
      ok: false,
      operation: "rebuild",
      sandboxName: "alpha",
      gatewayPort: 9000,
      message: expectedMessage,
    });
  });

  it("rejects invalid descriptor input before the rebuild pipeline boundary", async () => {
    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: null,
          executionOptions: {},
        } as never,
        9000,
      ),
    ).rejects.toThrow();
  });

  it("rejects delegated worker startup on unsupported native Windows", () => {
    expect(() => rebuildOwningRegistryDependencies.assertWorkerPlatformSupported("win32")).toThrow(
      "Delegated owning-registry rebuild work is unsupported on native Windows. Run NemoClaw inside WSL.",
    );
  });

  it.runIf(process.platform === "linux")(
    "forwards the route timeout and only allowlisted credentials into the delegated rebuild consumer",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-credential-"));
      const marker = path.join(home, "credential-probe.json");
      let started: ReturnType<typeof startWorkerWithControlledDeadline> | undefined;
      try {
        const recoveryManifest = writeRecoveryFixture(home);
        writeSiblingRegistry(home, {
          provider: "build",
          credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        });
        vi.stubEnv("HOME", home);
        vi.stubEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE", "1");
        vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", writeCredentialProbeOpenShell(home, marker));
        vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "3601");
        vi.stubEnv("NEMOCLAW_UNRELATED_SECRET", "must-not-cross-worker-boundary");
        vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "nvapi-worker-test-value");
        vi.stubEnv("OPENAI_API_KEY", "openai-unrelated-test-value");
        vi.stubEnv("UNRELATED_REBUILD_SECRET", "must-not-cross-worker-boundary");

        started = startWorkerWithControlledDeadline(() =>
          rebuildOwningRegistryDependencies.runWorker(
            {
              operation: "rebuild",
              sandboxName: "alpha",
              options: { yes: true },
              executionOptions: {
                recoveryManifest,
                allowLegacyManagedImageRecovery: true,
              },
            },
            9000,
            {
              credentialEnvNames: ["NVIDIA_INFERENCE_API_KEY"],
              timeoutMs: WORKER_FIXTURE_TIMEOUT_MS,
              terminationGraceMs: 100,
            },
          ),
        );
        await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), {
          timeout: WORKER_FIXTURE_TIMEOUT_MS,
        });
        const workerPid = Number(fs.readFileSync(marker, "utf8"));
        const workerEnvironment = fs
          .readFileSync(`/proc/${String(workerPid)}/environ`, "utf8")
          .split("\0");

        expect(workerEnvironment).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-worker-test-value");
        expect(workerEnvironment).toContain("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=3601");
        expect(workerEnvironment).not.toContain(
          "NEMOCLAW_UNRELATED_SECRET=must-not-cross-worker-boundary",
        );
        expect(workerEnvironment).not.toContain("OPENAI_API_KEY=openai-unrelated-test-value");
        expect(workerEnvironment).not.toContain(
          "UNRELATED_REBUILD_SECRET=must-not-cross-worker-boundary",
        );
        started.expire();
        await expect(started.worker).rejects.toThrow(
          "The worker was terminated, but the operation outcome is unknown.",
        );
      } finally {
        started?.expire();
        await started?.worker.catch(() => undefined);
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("binds a valid rebuild descriptor to the selected sibling registry root", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-sibling-root-"));
    try {
      writeSiblingRegistry(home, { provider: "nvidia-prod" });
      const recoveryManifest = writeRecoveryFixture(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE", "1");
      let failure: unknown;

      try {
        await rebuildOwningRegistryDependencies.runWorker(
          {
            operation: "rebuild",
            sandboxName: "alpha",
            options: { yes: true },
            executionOptions: { recoveryManifest },
          },
          9000,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "Recovery registry entry has no NemoClaw-managed image fingerprint.",
      );
      expect((failure as Error).cause).toEqual(
        expect.objectContaining({
          ok: false,
          operation: "rebuild",
          sandboxName: "alpha",
          gatewayPort: 9000,
          message: "Recovery registry entry has no NemoClaw-managed image fingerprint.",
        }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("waits for the owning sandbox lifecycle lock before retiring recovery", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-retirement-lock-"));
    let releaseLock: () => void = vi.fn();
    try {
      const manifest = writeRecoveryFixture(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", writeMissingSandboxOpenShell(home));
      const stateDir = path.join(home, ".nemoclaw", "gateways", "9000");
      let markLockHeld: () => void = vi.fn();
      const lockHeld = new Promise<void>((resolve) => {
        markLockHeld = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = withSandboxLifecycleLock(
        "alpha",
        async () => {
          markLockHeld();
          await release;
        },
        { stateDir },
      );
      await lockHeld;

      const worker = rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: TRANSACTION_ID,
          confirmDataRecovered: true,
        },
        9000,
      );

      const outcome = await Promise.race([
        worker.then(() => "completed" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 250)),
      ]);
      expect(outcome).toBe("waiting");
      expect(
        fs.existsSync(path.join(manifest.backupPath, manifest.rebuildPolicyHandoff.file)),
      ).toBe(true);

      releaseLock();
      await holder;
      await worker;
      expect(
        fs.existsSync(path.join(manifest.backupPath, manifest.rebuildPolicyHandoff.file)),
      ).toBe(false);
    } finally {
      releaseLock();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("terminates an unresponsive worker with an unknown-outcome recovery diagnostic", async () => {
    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: "11111111-1111-4111-8111-111111111111",
          confirmDataRecovered: true,
        },
        9000,
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow(
      "Delegated recovery retirement for sandbox 'alpha' on owning gateway port 9000 exceeded its 1 ms deadline. The worker was terminated, but the operation outcome is unknown. NemoClaw did not remove retained recovery state; inspect the sandbox and recovery state before retrying.",
    );
  });

  it("terminates worker descendants before reporting an unknown recovery outcome", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-process-group-"));
    const descendantMarker = path.join(home, "descendant.pid");
    let descendantPid: number | undefined;
    let started: ReturnType<typeof startWorkerWithControlledDeadline> | undefined;
    try {
      writeRecoveryFixture(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", writeBlockingOpenShell(home, descendantMarker));

      started = startWorkerWithControlledDeadline(() =>
        rebuildOwningRegistryDependencies.runWorker(
          {
            operation: "retire-recovery",
            sandboxName: "alpha",
            transactionId: TRANSACTION_ID,
            confirmDataRecovered: true,
          },
          9000,
          { timeoutMs: WORKER_FIXTURE_TIMEOUT_MS, terminationGraceMs: 100 },
        ),
      );
      await vi.waitFor(() => expect(fs.existsSync(descendantMarker)).toBe(true), {
        timeout: WORKER_FIXTURE_TIMEOUT_MS,
      });
      descendantPid = Number(fs.readFileSync(descendantMarker, "utf8"));
      started.expire();
      await expect(started.worker).rejects.toThrow(
        "The worker was terminated, but the operation outcome is unknown.",
      );
      expect(() => process.kill(descendantPid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      started?.expire();
      await started?.worker.catch(() => undefined);
      try {
        process.kill(descendantPid as number, "SIGKILL");
      } catch {
        // The process group cleanup succeeded or the marker was never written.
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it(
    "reaps a delegated worker process group before preserving parent SIGINT semantics",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-worker-sigint-"));
      const descendantMarker = path.join(home, "descendant.pid");
      const modulePath = path.join(
        import.meta.dirname,
        "../../dist/lib/actions/sandbox/rebuild/owning-registry.js",
      );
      let descendantPid: number | undefined;
      writeRecoveryFixture(home);
      const harness = spawn(
        process.execPath,
        [
          "-e",
          [
            `const { rebuildOwningRegistryDependencies } = require(${JSON.stringify(modulePath)});`,
            "void rebuildOwningRegistryDependencies.runWorker(",
            `  { operation: "retire-recovery", sandboxName: "alpha", transactionId: ${JSON.stringify(TRANSACTION_ID)}, confirmDataRecovered: true },`,
            "  9000,",
            "  { timeoutMs: 30000, terminationGraceMs: 100 },",
            ").catch((error) => { console.error(error); process.exitCode = 1; });",
          ].join("\n"),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            NEMOCLAW_OPENSHELL_BIN: writeBlockingOpenShell(home, descendantMarker),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output: Buffer[] = [];
      harness.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      harness.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
        (resolve, reject) => {
          harness.once("error", reject);
          harness.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      try {
        await vi.waitFor(() => expect(fs.existsSync(descendantMarker)).toBe(true), {
          timeout: testTimeout(20_000),
        });
        descendantPid = Number(fs.readFileSync(descendantMarker, "utf8"));

        expect(harness.kill("SIGINT")).toBe(true);
        await expect(exited).resolves.toEqual({ code: null, signal: "SIGINT" });
        expect(() => process.kill(descendantPid!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } catch (error) {
        throw new Error(`${String(error)}\n${Buffer.concat(output).toString("utf8")}`);
      } finally {
        harness.kill("SIGKILL");
        try {
          process.kill(descendantPid as number, "SIGKILL");
        } catch {
          // The delegated worker cleanup succeeded or the marker was never written.
        }
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    testTimeout(30_000),
  );

  it("reports an unreaped worker as potentially active", async () => {
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
      pid < 0 && signal === 0 ? true : kill(pid, signal),
    );

    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: TRANSACTION_ID,
          confirmDataRecovered: true,
        },
        9000,
        { timeoutMs: 1, terminationGraceMs: 1 },
      ),
    ).rejects.toThrow(
      /Delegated recovery retirement for sandbox 'alpha' on owning gateway port 9000 exceeded its 1 ms deadline\. Termination is unconfirmed for worker PID \d+, so the worker or one of its descendants may still be active and the operation outcome is unknown\. NemoClaw did not remove retained recovery state; inspect that worker, the sandbox, and recovery state before retrying\./,
    );
  });
});
