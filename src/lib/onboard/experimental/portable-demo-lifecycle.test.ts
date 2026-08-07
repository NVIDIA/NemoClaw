// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../../state/registry";
import { recordUserLocalOllamaOwnership } from "./ollama-user-local-runtime";
import {
  installPortableDemoSandboxLifecycle,
  portableDemoLifecycleInternals,
  recoverPortableDemoSandboxLifecycle,
} from "./portable-demo-lifecycle";

const CONTAINER_ID = "a".repeat(64);
const SANDBOX_ID = "sandbox-id-alpha";
const STARTUP_ARGV = [
  "env",
  "CHAT_UI_URL=http://127.0.0.1:18789",
  "NEMOCLAW_DASHBOARD_PORT=18789",
  "OPENCLAW_HOME=/sandbox",
  "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
  "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
  "NEMOCLAW_SANDBOX_NAME=alpha",
  "/usr/local/bin/nemoclaw-start",
];
const RECOVERY_STARTUP_ARGV = [
  "env",
  "NEMOCLAW_MANAGED_STARTUP_APPLIED=1",
  "_NEMOCLAW_CORPORATE_CA_MERGED=0",
  "NODE_EXTRA_CA_CERTS=/etc/openshell-tls/openshell-ca.pem",
  "DENO_CERT=/etc/openshell-tls/openshell-ca.pem",
  "SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem",
  "REQUESTS_CA_BUNDLE=/etc/openshell-tls/ca-bundle.pem",
  "CURL_CA_BUNDLE=/etc/openshell-tls/ca-bundle.pem",
  "GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem",
  ...STARTUP_ARGV.slice(1),
];

const temporaryDirectories: string[] = [];

function temporaryStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sandboxEntry(): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
}

function createPodman(
  options: { running?: boolean; sandboxId?: string; updateStatus?: number } = {},
) {
  let running = options.running ?? true;
  let sandboxId = options.sandboxId ?? SANDBOX_ID;
  let managedLabel = "true";
  let sandboxNameLabel = "alpha";
  const podman = vi.fn((args: readonly string[]) => {
    switch (args[0]) {
      case "ps":
        return { status: 0, stdout: `${CONTAINER_ID}\n` };
      case "inspect":
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: CONTAINER_ID,
              Config: {
                Labels: {
                  "openshell.managed": managedLabel,
                  "openshell.sandbox-id": sandboxId,
                  "openshell.sandbox-name": sandboxNameLabel,
                },
              },
              State: { Running: running },
            },
          ]),
        };
      case "start":
        running = true;
        return { status: 0 };
      case "update":
        return { status: options.updateStatus ?? 0 };
      default:
        throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    }
  });
  return {
    podman,
    setSandboxId(value: string) {
      sandboxId = value;
    },
    setManagedLabel(value: string) {
      managedLabel = value;
    },
    setSandboxNameLabel(value: string) {
      sandboxNameLabel = value;
    },
  };
}

function installReceipt(stateDir: string, podman: ReturnType<typeof createPodman>["podman"]): void {
  installPortableDemoSandboxLifecycle(
    "alpha",
    STARTUP_ARGV,
    { HOME: stateDir, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    { platform: "linux", podman, stateDir },
  );
}

function createManagedOllamaBinary(homeDir: string): string {
  const binPath = path.join(homeDir, ".local", "bin", "ollama");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, "#!/bin/sh\n", { mode: 0o755 });
  return binPath;
}

function expectRecoveryIdentityRefusal(
  stateDir: string,
  runtime: ReturnType<typeof createPodman>,
): void {
  const launchOpenshell = vi.fn();

  expect(() =>
    recoverPortableDemoSandboxLifecycle(
      "alpha",
      { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
      {
        platform: "linux",
        stateDir,
        podman: runtime.podman,
        launchOpenshell,
      },
    ),
  ).toThrow("OpenShell identity does not match");
  expect(runtime.podman).not.toHaveBeenCalledWith(["start", CONTAINER_ID]);
  expect(launchOpenshell).not.toHaveBeenCalled();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable demo sandbox lifecycle", () => {
  it("does not inspect Podman unless the portable profile is explicit (#8441)", () => {
    const podman = vi.fn();

    installPortableDemoSandboxLifecycle("alpha", STARTUP_ARGV, {}, { podman });

    expect(podman).not.toHaveBeenCalled();
  });

  it("does not install an OpenClaw demo receipt for another startup contract (#8441)", () => {
    const podman = vi.fn();

    installPortableDemoSandboxLifecycle(
      "alpha",
      ["env", "NEMOCLAW_OBSERVABILITY=0", "/usr/local/bin/nemoclaw-start"],
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      { platform: "linux", podman },
    );

    expect(podman).not.toHaveBeenCalled();
  });

  it("ignores an installed receipt for another agent (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "hermes", gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toEqual({ kind: "not-installed" });
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("rejects an installed receipt outside Linux (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw" },
        { platform: "darwin", stateDir, podman: runtime.podman },
      ),
    ).toThrow("receipt is only valid on Linux");
  });

  it("rejects a receipt with an out-of-range dashboard port (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf8"));
    fs.writeFileSync(filePath, `${JSON.stringify({ ...receipt, dashboardPort: 65_536 })}\n`, {
      mode: 0o600,
    });
    runtime.podman.mockClear();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toThrow("receipt values are invalid");
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("records the exact OpenShell container and applies the unless-stopped restart policy (#8441)", () => {
    const stateDir = temporaryStateDir();
    const { podman } = createPodman();

    installReceipt(stateDir, podman);

    expect(podman).toHaveBeenCalledWith([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      "label=openshell.managed=true",
      "--filter",
      "label=openshell.sandbox-name=alpha",
      "--format",
      "{{.ID}}",
    ]);
    expect(podman).toHaveBeenCalledWith(["update", "--restart=unless-stopped", CONTAINER_ID]);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(receipt).toEqual({
      schemaVersion: 2,
      sandboxName: "alpha",
      sandboxId: SANDBOX_ID,
      containerId: CONTAINER_ID,
      dashboardPort: 18789,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("does not persist proxy credentials from the create-time environment (#8441)", () => {
    const stateDir = temporaryStateDir();
    const { podman } = createPodman();

    installPortableDemoSandboxLifecycle(
      "alpha",
      [
        ...STARTUP_ARGV.slice(0, -1),
        "HTTPS_PROXY=https://user:password@example.test",
        STARTUP_ARGV.at(-1)!,
      ],
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      { platform: "linux", podman, stateDir },
    );

    const receipt = fs.readFileSync(
      portableDemoLifecycleInternals.receiptPath("alpha", stateDir),
      "utf-8",
    );
    expect(receipt).not.toContain("PROXY");
    expect(receipt).not.toContain("user:password");
  });

  it("does not record lifecycle ownership when the restart policy update fails (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ updateStatus: 125 });

    expect(() => installReceipt(stateDir, runtime.podman)).toThrow(
      "Setting the portable restart policy",
    );
    expect(fs.existsSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir))).toBe(
      false,
    );
  });

  it("starts the stopped container with the current OpenShell CA environment (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ running: false });
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
      switch (command) {
        case "true":
          return { status: 0 };
        case "pgrep":
          return { status: 1 };
        case "curl":
          return launchOpenshell.mock.calls.length === 0
            ? { status: 0, stdout: "000" }
            : { status: 0, stdout: "200" };
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });

    const result = recoverPortableDemoSandboxLifecycle(
      "alpha",
      { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
      {
        platform: "linux",
        stateDir,
        podman: runtime.podman,
        captureOpenshell,
        launchOpenshell,
        log,
      },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(runtime.podman).toHaveBeenCalledWith(["start", CONTAINER_ID]);
    expect(launchOpenshell).toHaveBeenCalledWith([
      "sandbox",
      "exec",
      "-g",
      "nemoclaw",
      "--name",
      "alpha",
      "--no-tty",
      "--",
      ...RECOVERY_STARTUP_ARGV,
    ]);
    expect(log).toHaveBeenCalledWith("  Portable demo lifecycle recovered sandbox 'alpha'.");
  });

  it("waits through a transient OpenShell registration gap after starting the container (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ running: false });
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    let now = 0;
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
      switch (command) {
        case "true":
          return { status: now >= 31_000 ? 0 : 1 };
        case "pgrep":
          return { status: 1 };
        case "curl":
          return launchOpenshell.mock.calls.length === 0
            ? { status: 0, stdout: "000" }
            : { status: 0, stdout: "200" };
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell,
          launchOpenshell,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).toEqual({ kind: "recovered" });
    expect(now).toBe(31_000);
    expect(launchOpenshell).toHaveBeenCalledOnce();
  });

  it("waits for the agent gateway to pass its health check when the managed startup process already exists (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    let now = 0;
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
      switch (command) {
        case "true":
        case "pgrep":
          return { status: 0 };
        case "curl":
          return { status: 0, stdout: now >= 2_000 ? "200" : "000" };
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell,
          launchOpenshell,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(now).toBe(2_000);
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("fails after the startup timeout when the managed startup process exists and the agent gateway does not pass its health check (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    let now = 0;

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "000" } : { status: 0 },
          launchOpenshell,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).toThrow("has a startup process, but its agent gateway did not pass");
    expect(now).toBe(90_000);
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("retries the same receipt after a detached startup times out (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const originalReceipt = fs.readFileSync(receiptPath, "utf-8");
    const launchOpenshell = vi.fn();
    let now = 0;
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
      switch (command) {
        case "true":
          return { status: 0 };
        case "pgrep":
          return { status: 1 };
        case "curl":
          return launchOpenshell.mock.calls.length >= 2
            ? { status: 0, stdout: "200" }
            : { status: 0, stdout: "000" };
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });
    const deps = {
      platform: "linux" as const,
      stateDir,
      podman: runtime.podman,
      captureOpenshell,
      launchOpenshell,
      now: () => now,
      sleep: (milliseconds: number) => {
        now += milliseconds;
      },
    };

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        deps,
      ),
    ).toThrow("startup did not start its agent gateway");

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        deps,
      ),
    ).toEqual({ kind: "recovered" });
    expect(launchOpenshell).toHaveBeenCalledTimes(2);
    expect(runtime.podman).not.toHaveBeenCalledWith(["start", expect.any(String)]);
    expect(fs.readFileSync(receiptPath, "utf-8")).toBe(originalReceipt);
  });

  it("removes only the stale receipt when its exact container no longer exists (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const otherFilePath = portableDemoLifecycleInternals.receiptPath("beta", stateDir);
    const otherReceipt = '{"sandboxName":"beta"}\n';
    fs.writeFileSync(otherFilePath, otherReceipt, { mode: 0o600 });
    runtime.podman.mockReturnValue({
      status: 125,
      stdout: `Error: no such container ${CONTAINER_ID}`,
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toEqual({ kind: "not-installed" });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readFileSync(otherFilePath, "utf-8")).toBe(otherReceipt);
  });

  it("does not launch a second startup command when the agent gateway responds (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();

    const result = recoverPortableDemoSandboxLifecycle(
      "alpha",
      { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
      {
        platform: "linux",
        stateDir,
        podman: runtime.podman,
        captureOpenshell: (args) =>
          args.includes("curl") ? { status: 0, stdout: "401" } : { status: 0 },
        launchOpenshell,
      },
    );

    expect(result).toEqual({ kind: "already-running" });
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("restarts receipt-owned user-local Ollama before reporting portable recovery complete (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    recordUserLocalOllamaOwnership(binPath, { homeDir: stateDir, stateDir });
    let ollamaStarted = false;
    const captureHost = vi.fn((command: string) => {
      switch (command) {
        case "pgrep":
          return { status: 1 };
        case "curl":
          return ollamaStarted
            ? { status: 0, stdout: JSON.stringify({ models: [] }) }
            : { status: 7, stderr: "connection refused" };
        default:
          throw new Error(`Unexpected host command: ${command}`);
      }
    });
    const launchHost = vi.fn(() => {
      ollamaStarted = true;
    });
    const log = vi.fn();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost,
          launchHost,
          log,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchHost).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["serve"],
      {
        HOME: stateDir,
        OLLAMA_HOST: "127.0.0.1:11434",
      },
      expect.any(Number),
    );
    expect(log).toHaveBeenCalledWith(
      "  Portable demo lifecycle restarted NemoClaw-managed Ollama.",
    );
    expect(captureHost).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining(["--noproxy", "127.0.0.1"]),
      5000,
    );
  });

  it("launches the validated Ollama identity when its pathname is replaced (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    recordUserLocalOllamaOwnership(binPath, { homeDir: stateDir, stateDir });
    let ollamaStarted = false;
    const captureHost = vi.fn((command: string) =>
      command === "pgrep"
        ? { status: 1 }
        : ollamaStarted
          ? { status: 0, stdout: JSON.stringify({ models: [] }) }
          : { status: 7 },
    );
    const launchHost = vi.fn(
      (_command: string, _args: readonly string[], _env: NodeJS.ProcessEnv, descriptor: number) => {
        fs.renameSync(binPath, `${binPath}.validated`);
        fs.writeFileSync(binPath, "#!/bin/sh\n# replacement\n", { mode: 0o755 });
        expect(fs.readFileSync(descriptor, "utf8")).toBe("#!/bin/sh\n");
        ollamaStarted = true;
      },
    );

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost,
          launchHost,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchHost).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["serve"],
      expect.objectContaining({ OLLAMA_HOST: "127.0.0.1:11434" }),
      expect.any(Number),
    );
  });

  it("records an explicitly re-enrolled pre-receipt Ollama before recovery (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    let ollamaStarted = false;
    const launchHost = vi.fn(() => {
      ollamaStarted = true;
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost: (command) =>
            command === "pgrep"
              ? { status: 1 }
              : ollamaStarted
                ? { status: 0, stdout: JSON.stringify({ models: [] }) }
                : { status: 7 },
          launchHost,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stateDir, "ollama", "user-local-ownership.json"), "utf8"),
      ),
    ).toMatchObject({ binPath });
    expect(launchHost).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["serve"],
      {
        HOME: stateDir,
        OLLAMA_HOST: "127.0.0.1:11434",
      },
      expect.any(Number),
    );
  });

  it("rejects Ollama re-enrollment for a non-Ollama sandbox (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "nvidia" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
        },
      ),
    ).toThrow("requires a portable sandbox with the recorded ollama-local provider");
  });

  it("rejects a symlink before recording explicit Ollama re-enrollment (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    const targetPath = path.join(stateDir, "ollama-target");
    fs.renameSync(binPath, targetPath);
    fs.symlinkSync(targetPath, binPath);

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
        },
      ),
    ).toThrow("is not a regular executable");
    expect(fs.existsSync(path.join(stateDir, "ollama", "user-local-ownership.json"))).toBe(false);
  });

  it("rejects a symlinked receipt directory during explicit Ollama re-enrollment (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    createManagedOllamaBinary(stateDir);
    const plantedDirectory = path.join(stateDir, "planted-ollama-state");
    const receiptDirectory = path.join(stateDir, "ollama");
    fs.mkdirSync(plantedDirectory, { mode: 0o700 });
    fs.symlinkSync(plantedDirectory, receiptDirectory);
    vi.stubEnv("HOME", stateDir);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          launchHost,
        },
      ),
    ).toThrow("is a symbolic link");
    expect(fs.existsSync(path.join(plantedDirectory, "user-local-ownership.json"))).toBe(false);
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("does not inspect ownership or launch Ollama when the local API is already healthy (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const loadManagedOllama = vi.fn();
    const launchHost = vi.fn();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost: (command) =>
            command === "curl"
              ? { status: 0, stdout: JSON.stringify({ models: [] }) }
              : { status: 1 },
          launchHost,
          loadManagedOllama,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(loadManagedOllama).not.toHaveBeenCalled();
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("does not launch an unowned user-local Ollama binary (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchHost = vi.fn();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost: () => ({ status: 7 }),
          launchHost,
          loadManagedOllama: () => null,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("refuses to launch a duplicate when another Ollama process is unhealthy (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: (command) => ({ status: command === "pgrep" ? 0 : 7 }),
          launchHost,
          loadManagedOllama: () => binPath,
        },
      ),
    ).toThrow("refused to launch a duplicate");
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("refuses a receipt-owned Ollama binary that is not executable (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    fs.chmodSync(binPath, 0o600);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: () => ({ status: 7 }),
          launchHost,
          loadManagedOllama: () => binPath,
        },
      ),
    ).toThrow("is not a regular executable");
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("refuses a receipt-owned Ollama path that is a symbolic link (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const targetPath = createManagedOllamaBinary(stateDir);
    const binPath = path.join(stateDir, "ollama-link");
    fs.symlinkSync(targetPath, binPath);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: () => ({ status: 7 }),
          launchHost,
          loadManagedOllama: () => binPath,
        },
      ),
    ).toThrow("is not a regular executable");
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("fails after the bounded timeout when restarted Ollama stays unhealthy (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    let now = 0;
    const launchHost = vi.fn();

    let failure: Error | undefined;
    try {
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: (command) =>
            command === "pgrep"
              ? { status: 1 }
              : { status: 0, stdout: JSON.stringify({ status: "ok" }) },
          launchHost,
          loadManagedOllama: () => binPath,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      );
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain("did not become healthy");
    expect(failure?.message).toContain(
      `start the receipt-bound executable at ${JSON.stringify(binPath)} with the 'serve' argument, then retry`,
    );
    expect(now).toBe(30_000);
    expect(launchHost).toHaveBeenCalledOnce();
  });

  it("restarts the managed startup process once when recovery upgrades a schema-1 receipt (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, schemaVersion: 1 }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    let startupRunning = true;
    let gatewayRunning = true;
    const launchOpenshell = vi.fn(() => {
      startupRunning = true;
      gatewayRunning = true;
    });
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "pkill", "curl"].includes(arg));
      switch (command) {
        case "true":
          return { status: 0 };
        case "pgrep":
          return { status: startupRunning ? 0 : 1 };
        case "pkill":
          startupRunning = false;
          gatewayRunning = false;
          return { status: 0 };
        case "curl":
          return { status: 0, stdout: gatewayRunning ? "200" : "000" };
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });
    const deps = {
      platform: "linux" as const,
      stateDir,
      podman: runtime.podman,
      captureOpenshell,
      launchOpenshell,
    };

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        deps,
      ),
    ).toEqual({ kind: "recovered" });
    expect(captureOpenshell).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "-g",
        "nemoclaw",
        "--name",
        "alpha",
        "--no-tty",
        "--",
        "pkill",
        "-TERM",
        "-f",
        "^(/usr/local/bin/nemoclaw-start|(bash|/bin/bash|/usr/bin/bash) /usr/local/bin/nemoclaw-start)( |$)",
      ],
      5000,
    );
    expect(launchOpenshell).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf-8"))).toMatchObject({ schemaVersion: 2 });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        deps,
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchOpenshell).toHaveBeenCalledOnce();
  });

  it("fails closed for a schema-1 receipt when the gateway is healthy without its managed startup process (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, schemaVersion: 1 }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    const launchOpenshell = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) => {
            const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
            switch (command) {
              case "curl":
                return { status: 0, stdout: "200" };
              case "pgrep":
                return { status: 1 };
              default:
                return { status: 0 };
            }
          },
          launchOpenshell,
        },
      ),
    ).toThrow("agent gateway without its managed startup process");
    expect(launchOpenshell).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf-8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("refuses a container whose OpenShell sandbox ID changed (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setSandboxId("different-sandbox-id");
    const launchOpenshell = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          launchOpenshell,
        },
      ),
    ).toThrow("OpenShell sandbox ID changed");
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("refuses a container whose OpenShell managed label is not true (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setManagedLabel("false");

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });

  it("refuses a container whose OpenShell sandbox name changed (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setSandboxNameLabel("different-name");

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });
});
