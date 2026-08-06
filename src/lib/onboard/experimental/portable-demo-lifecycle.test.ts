// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../../state/registry";
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

function createPodman(options: { running?: boolean; sandboxId?: string } = {}) {
  let running = options.running ?? true;
  let sandboxId = options.sandboxId ?? SANDBOX_ID;
  const podman = vi.fn((args: readonly string[]) => {
    if (args[0] === "ps") return { status: 0, stdout: `${CONTAINER_ID}\n` };
    if (args[0] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Config: {
              Labels: {
                "openshell.managed": "true",
                "openshell.sandbox-id": sandboxId,
                "openshell.sandbox-name": "alpha",
              },
            },
            State: { Running: running },
          },
        ]),
      };
    }
    if (args[0] === "start") {
      running = true;
      return { status: 0 };
    }
    if (args[0] === "update") return { status: 0 };
    throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
  });
  return {
    podman,
    setSandboxId(value: string) {
      sandboxId = value;
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

  it("records the exact OpenShell container and applies unless-stopped restart (#8441)", () => {
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
      schemaVersion: 1,
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

  it("starts the stopped container and launches the fixed OpenClaw startup command (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ running: false });
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      if (args.includes("true")) return { status: 0 };
      if (args.includes("pgrep")) return { status: 1 };
      if (args.includes("curl")) {
        return launchOpenshell.mock.calls.length === 0
          ? { status: 0, stdout: "000" }
          : { status: 0, stdout: "200" };
      }
      throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
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
      ...STARTUP_ARGV,
    ]);
    expect(log).toHaveBeenCalledWith("  Portable demo lifecycle recovered sandbox 'alpha'.");
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
});
