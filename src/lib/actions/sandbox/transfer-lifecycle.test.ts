// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { run, probe, gateway, ensure } = vi.hoisted(() => ({
  run: vi.fn(),
  probe: vi.fn(),
  gateway: vi.fn(),
  ensure: vi.fn(),
}));
vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit: ensure,
  getKnownSandboxTargetGatewayName: gateway,
}));
vi.mock("../../adapters/openshell/sandbox-transfer-cli", () => ({
  createCliOpenShellSandboxTransferExecutor: () => ({ run }),
}));
vi.mock("../../adapters/openshell/sandbox-command-cli", () => ({
  createCliOpenShellSandboxCommandExecutor: () => ({ runBuffered: probe }),
}));

import type {
  OpenShellSandboxTransferCompletion,
  OpenShellSandboxTransferRequest,
} from "../../adapters/openshell/sandbox-transfer";
import type { OpenShellSandboxBufferedCommandCompletion } from "../../adapters/openshell/sandbox-command";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import * as lockStorage from "../../state/mcp-lifecycle-lock-storage";
import { getMcpLifecycleLockPath } from "../../state/mcp-lifecycle-lock-storage";
import { downloadFromSandbox } from "./download";
import { uploadToSandbox } from "./upload";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const fileProbe: OpenShellSandboxBufferedCommandCompletion = {
  outcome: { kind: "completed", exitCode: 0 },
  stdout: "file",
  stderr: "",
};
function completed(
  release = vi.fn(),
  wasInterrupted = () => false,
): OpenShellSandboxTransferCompletion {
  return { outcome: { kind: "completed", exitCode: 0 }, release, wasInterrupted };
}

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-lifecycle-"));
  run.mockReset();
  probe.mockReset();
  gateway.mockReset();
  ensure.mockReset();
  ensure.mockResolvedValue(undefined);
  gateway.mockReturnValue("nemoclaw-8091");
  probe.mockResolvedValue(fileProbe);
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("user transfer lifecycle", () => {
  it.each([
    ["upload", () => uploadToSandbox({ sandboxName: "alpha", hostPath: "./source" })],
    [
      "download",
      () =>
        downloadFromSandbox({
          sandboxName: "alpha",
          sandboxPath: "/sandbox/file",
          hostDest: directory,
        }),
    ],
  ] as const)("does not describe an interrupted %s as exit zero", async (_direction, action) => {
    const release = vi.fn();
    run.mockResolvedValue(completed(release, () => true));
    await expect(action()).rejects.toThrow("exit null");
    expect(release).toHaveBeenCalledOnce();
    expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
  });

  it("keeps staging and the lock until transfer and revalidation settle", async () => {
    const started = deferred<void>();
    const transfer = deferred<OpenShellSandboxTransferCompletion>();
    const inspecting = deferred<void>();
    const revalidation = deferred<OpenShellSandboxBufferedCommandCompletion>();
    const destination = path.join(directory, "result");
    let staged = "";
    let settled = false;
    const release = vi.fn(() => {
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
      expect(fs.existsSync(path.dirname(staged))).toBe(false);
    });
    run.mockImplementation((request: OpenShellSandboxTransferRequest) => {
      staged = request.destination;
      fs.writeFileSync(staged, "new data");
      started.resolve();
      return transfer.promise;
    });
    probe.mockResolvedValueOnce(fileProbe).mockImplementationOnce(() => {
      inspecting.resolve();
      return revalidation.promise;
    });
    const pending = downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/file",
      hostDest: destination,
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await started.promise;
      expect(settled).toBe(false);
      expect(fs.existsSync(staged)).toBe(true);
      expect(fs.existsSync(destination)).toBe(false);
      await expect(
        withMcpLifecycleLock(
          "alpha",
          () => {
            throw new Error("entered competing mutation");
          },
          { timeoutMs: 25, pollIntervalMs: 1 },
        ),
      ).rejects.toThrow(/lock/i);
      gateway.mockReturnValue("nemoclaw-9000");
      transfer.resolve(completed(release));
      await inspecting.promise;
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(true);
      expect(fs.existsSync(staged)).toBe(true);
      expect(fs.existsSync(destination)).toBe(false);
      expect(release).not.toHaveBeenCalled();
      revalidation.resolve(fileProbe);
      await expect(pending).resolves.toEqual({
        sandboxPath: "/sandbox/file",
        hostDest: destination,
      });
      expect(fs.readFileSync(destination, "utf8")).toBe("new data");
      expect(release).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].target).toEqual({
        kind: "named",
        gatewayName: "nemoclaw-8091",
      });
      expect(probe.mock.calls.map(([request]) => request.target)).toEqual([
        { kind: "named", gatewayName: "nemoclaw-8091" },
        { kind: "named", gatewayName: "nemoclaw-8091" },
      ]);
      await expect(withMcpLifecycleLock("alpha", () => "available")).resolves.toBe("available");
    } finally {
      transfer.resolve(completed(release));
      revalidation.resolve(fileProbe);
      await pending.catch(() => undefined);
    }
  });

  it.each([
    {
      failure: "transfer rejection",
      transferResult: (_completion: OpenShellSandboxTransferCompletion) => {
        throw new Error("transfer rejected");
      },
      revalidate: (_interrupt: () => void) => fileProbe,
      releaseCount: 0,
    },
    {
      failure: "revalidation rejection",
      transferResult: (completion: OpenShellSandboxTransferCompletion) => completion,
      revalidate: (_interrupt: () => void) => {
        throw new Error("revalidation rejected");
      },
      releaseCount: 1,
    },
    {
      failure: "interruption",
      transferResult: (completion: OpenShellSandboxTransferCompletion) => completion,
      revalidate: (interrupt: () => void) => {
        interrupt();
        return fileProbe;
      },
      releaseCount: 1,
    },
  ])(
    "preserves the destination and removes staging after $failure",
    async ({ transferResult, revalidate, releaseCount }) => {
      const destination = path.join(directory, "existing");
      fs.writeFileSync(destination, "original");
      let staged = "";
      let interrupted = false;
      const release = vi.fn(() => {
        expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
        expect(fs.existsSync(path.dirname(staged))).toBe(false);
      });
      run.mockImplementation(async (request: OpenShellSandboxTransferRequest) => {
        staged = request.destination;
        fs.writeFileSync(staged, "partial");
        return transferResult(completed(release, () => interrupted));
      });
      probe.mockResolvedValueOnce(fileProbe).mockImplementationOnce(async () => {
        return revalidate(() => {
          interrupted = true;
        });
      });
      await expect(
        downloadFromSandbox({
          sandboxName: "alpha",
          sandboxPath: "/sandbox/file",
          hostDest: destination,
        }),
      ).rejects.toThrow();
      expect(fs.readFileSync(destination, "utf8")).toBe("original");
      expect(fs.existsSync(path.dirname(staged))).toBe(false);
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
      expect(run).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledTimes(releaseCount);
    },
  );

  it("does not transfer when a failed source probe prints a success-shaped value", async () => {
    probe.mockResolvedValue({ ...fileProbe, outcome: { kind: "completed", exitCode: 1 } });
    await expect(
      downloadFromSandbox({
        sandboxName: "alpha",
        sandboxPath: "/sandbox/file",
        hostDest: directory,
      }),
    ).rejects.toThrow(/could not verify/);
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
  });

  it("keeps upload pending and propagates a nonzero exit after releasing the lock", async () => {
    const started = deferred<void>();
    const transfer = deferred<OpenShellSandboxTransferCompletion>();
    let settled = false;
    const release = vi.fn(() => {
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
    });
    run.mockImplementation(() => {
      started.resolve();
      return transfer.promise;
    });
    const pending = uploadToSandbox({
      sandboxName: "alpha",
      hostPath: path.join(directory, "source"),
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await started.promise;
      expect(settled).toBe(false);
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(true);
      transfer.resolve({ ...completed(release), outcome: { kind: "completed", exitCode: 7 } });
      await expect(pending).rejects.toMatchObject({
        exitCode: 7,
        message: "OpenShell command failed (exit 7)",
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      transfer.resolve(completed(release));
      await pending.catch(() => undefined);
    }
  });

  it("does not return success when interruption arrives during lock release", async () => {
    const releasing = deferred<void>();
    const finishRelease = deferred<void>();
    const originalRelease = lockStorage.safelyReleaseMcpLifecycleLock;
    vi.spyOn(lockStorage, "safelyReleaseMcpLifecycleLock").mockImplementation(async (...args) => {
      releasing.resolve();
      await finishRelease.promise;
      return originalRelease(...args);
    });
    let interrupted = false;
    const release = vi.fn();
    run.mockResolvedValue(completed(release, () => interrupted));
    const pending = uploadToSandbox({ sandboxName: "alpha", hostPath: "./source" });
    void pending.catch(() => undefined);
    try {
      await releasing.promise;
      expect(release).not.toHaveBeenCalled();
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(true);
      interrupted = true;
      finishRelease.resolve();
      await expect(pending).rejects.toMatchObject({ exitCode: 1 });
      expect(release).toHaveBeenCalledOnce();
      expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
    } finally {
      finishRelease.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("releases the lifecycle lock when liveness requests a terminal exit", async () => {
    ensure.mockImplementation(async (_name, { exit }) => exit(1));
    await expect(
      uploadToSandbox({ sandboxName: "alpha", hostPath: "./source" }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(getMcpLifecycleLockPath("alpha"))).toBe(false);
  });
});
