// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";

import {
  abortOpenClawPostRestoreDoctor,
  beginOpenClawBackupQuiesce,
  beginOpenClawPostRestoreDoctor,
  buildOpenClawBackupQuiesceDoctorPromotionCommand,
  buildOpenClawPostUpgradeDoctorAbortCommand,
  buildOpenClawPostUpgradeDoctorDeleteRetirementCommand,
  buildOpenClawPostUpgradeDoctorMarkerCommand,
  buildOpenClawPostUpgradeDoctorReleaseCommand,
  finishOpenClawPostRestoreDoctor,
  promoteOpenClawBackupQuiesceToPostRestoreDoctor,
  releaseOpenClawPostRestoreDoctorForDelete,
  retireOpenClawPostRestoreDoctorForDelete,
} from "./process-recovery";

function fakeGnuStatEnv(root: string): NodeJS.ProcessEnv {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "stat"),
    `#!/bin/sh\npython3 - "$2" "$3" <<'PY'\nimport os, stat, sys\ns = os.stat(sys.argv[2], follow_symlinks=False)\nvalues = {"%u": str(s.st_uid), "%a %h %s": f"{stat.S_IMODE(s.st_mode):o} {s.st_nlink} {s.st_size}"}\nprint(values[sys.argv[1]])\nPY\n`,
    { mode: 0o755 },
  );
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

describe("OpenClaw post-upgrade recovery doctor", () => {
  it("publishes an owner-only one-shot marker atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-marker-"));
    try {
      const command = buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll(
        "/sandbox/.openclaw",
        root,
      );
      execFileSync("bash", ["-c", command]);

      const marker = path.join(root, ".nemoclaw-post-upgrade-doctor");
      expect(fs.readFileSync(marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v2\n");
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["chmod", "printf", "mv"])(
    "fails closed when the atomic marker %s operation fails",
    (operation) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-marker-failure-"));
      try {
        const command = buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll(
          "/sandbox/.openclaw",
          root,
        );
        const result = spawnSync("bash", ["-c", `${operation}() { return 19; }; ${command}`], {
          encoding: "utf8",
        });

        expect(result.status).not.toBe(0);
        expect(fs.existsSync(path.join(root, ".nemoclaw-post-upgrade-doctor"))).toBe(false);
        expect(fs.readdirSync(root)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("publishes an owner-only abort transition atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-abort-"));
    const ready = path.join(root, "doctor-ready");
    try {
      execFileSync("bash", [
        "-c",
        buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll("/sandbox/.openclaw", root),
      ]);
      fs.writeFileSync(ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
        mode: 0o600,
      });
      const command = buildOpenClawPostUpgradeDoctorAbortCommand()
        .replaceAll("/sandbox/.openclaw", root)
        .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", ready);
      const env = fakeGnuStatEnv(root);

      execFileSync("bash", ["-c", command], { env });
      execFileSync("bash", ["-c", command], { env });

      const marker = path.join(root, ".nemoclaw-post-upgrade-doctor");
      expect(fs.readFileSync(marker, "utf8")).toBe(
        "nemoclaw-openclaw-post-upgrade-doctor-abort-v1\n",
      );
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("promotes only a verified backup quiesce receipt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-promote-"));
    const ready = path.join(root, "doctor-ready");
    try {
      execFileSync("bash", [
        "-c",
        buildOpenClawPostUpgradeDoctorMarkerCommand(
          "nemoclaw-openclaw-backup-quiesce-v1",
        ).replaceAll("/sandbox/.openclaw", root),
      ]);
      fs.writeFileSync(ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
        mode: 0o600,
      });
      const command = buildOpenClawBackupQuiesceDoctorPromotionCommand()
        .replaceAll("/sandbox/.openclaw", root)
        .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", ready);

      execFileSync("bash", ["-c", command], { env: fakeGnuStatEnv(root) });

      expect(fs.readFileSync(path.join(root, ".nemoclaw-post-upgrade-doctor"), "utf8")).toBe(
        "nemoclaw-openclaw-backup-quiesce-promote-doctor-v1\n",
      );
      expect(fs.readFileSync(ready, "utf8")).toBe(
        "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the ready receipt and persistent marker at the rebuild delete edge", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-retire-"));
    const ready = path.join(root, "doctor-ready");
    try {
      execFileSync("bash", [
        "-c",
        buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll("/sandbox/.openclaw", root),
      ]);
      fs.writeFileSync(ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
        mode: 0o600,
      });
      const command = buildOpenClawPostUpgradeDoctorDeleteRetirementCommand()
        .replaceAll("/sandbox/.openclaw", root)
        .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", ready);

      execFileSync("bash", ["-c", command], { env: fakeGnuStatEnv(root) });

      expect(fs.existsSync(path.join(root, ".nemoclaw-post-upgrade-doctor"))).toBe(false);
      expect(fs.existsSync(ready)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["chmod", "printf", "mv"])(
    "retains the armed maintenance request when atomic abort %s fails",
    (operation) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-abort-failure-"));
      const ready = path.join(root, "doctor-ready");
      try {
        execFileSync("bash", [
          "-c",
          buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll("/sandbox/.openclaw", root),
        ]);
        fs.writeFileSync(ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
          mode: 0o600,
        });
        const command = buildOpenClawPostUpgradeDoctorAbortCommand()
          .replaceAll("/sandbox/.openclaw", root)
          .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", ready);
        const result = spawnSync("bash", ["-c", `${operation}() { return 19; }; ${command}`], {
          encoding: "utf8",
          env: fakeGnuStatEnv(root),
        });

        expect(result.status).not.toBe(0);
        expect(fs.readFileSync(path.join(root, ".nemoclaw-post-upgrade-doctor"), "utf8")).toBe(
          "nemoclaw-openclaw-post-upgrade-doctor-v2\n",
        );
        expect(
          fs
            .readdirSync(root)
            .filter((entry) => entry.startsWith(".nemoclaw-post-upgrade-doctor.")),
        ).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("publishes the maintenance release atomically without deleting the gate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-release-"));
    const ready = path.join(root, "doctor-ready");
    try {
      execFileSync("bash", [
        "-c",
        buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll("/sandbox/.openclaw", root),
      ]);
      fs.writeFileSync(ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
        mode: 0o600,
      });
      const command = buildOpenClawPostUpgradeDoctorReleaseCommand()
        .replaceAll("/sandbox/.openclaw", root)
        .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", ready);

      execFileSync("bash", ["-c", command], { env: fakeGnuStatEnv(root) });

      const marker = path.join(root, ".nemoclaw-post-upgrade-doctor");
      expect(fs.readFileSync(marker, "utf8")).toBe(
        "nemoclaw-openclaw-post-upgrade-doctor-release-v1\n",
      );
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(ready, "utf8")).toBe(
        "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["chmod", "printf", "mv"])(
    "retains the maintenance request when atomic release %s fails",
    (operation) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-release-failure-"));
      const ready = path.join(root, "doctor-ready");
      try {
        execFileSync("bash", [
          "-c",
          buildOpenClawPostUpgradeDoctorMarkerCommand().replaceAll("/sandbox/.openclaw", root),
        ]);
        fs.writeFileSync(ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
          mode: 0o600,
        });
        const command = buildOpenClawPostUpgradeDoctorReleaseCommand()
          .replaceAll("/sandbox/.openclaw", root)
          .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", ready);
        const result = spawnSync("bash", ["-c", `${operation}() { return 19; }; ${command}`], {
          encoding: "utf8",
          env: fakeGnuStatEnv(root),
        });

        expect(result.status).not.toBe(0);
        expect(fs.readFileSync(path.join(root, ".nemoclaw-post-upgrade-doctor"), "utf8")).toBe(
          "nemoclaw-openclaw-post-upgrade-doctor-v2\n",
        );
        expect(
          fs
            .readdirSync(root)
            .filter((entry) => entry.startsWith(".nemoclaw-post-upgrade-doctor.")),
        ).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("holds a pinned restart after doctor, then releases one final healthy start", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 26, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const capture = vi.fn((_args: readonly string[], _options: Record<string, unknown>) => ({
      status: 0,
      output: "",
    }));
    const sleep = vi.fn(async () => undefined);
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default" as const,
      localTlsDir: "/authority/tls",
    };

    const deps = {
      captureOpenshell: capture as never,
      executeSandboxExecCommand: execute,
      now: () => 0,
      sleep,
    };
    const begun = await beginOpenClawPostRestoreDoctor("alpha", runtimeSelection, deps);
    expect(begun).toEqual({
      ok: true,
      window: { sandboxName: "alpha", runtimeSelection },
    });
    const verifiedWindow = begun as {
      ok: true;
      window: Parameters<typeof finishOpenClawPostRestoreDoctor>[0];
    };
    await expect(finishOpenClawPostRestoreDoctor(verifiedWindow.window, deps)).resolves.toEqual({
      ok: true,
    });

    expect(capture.mock.calls.map((call) => call[0])).toEqual([
      ["sandbox", "stop", "alpha"],
      ["sandbox", "start", "alpha"],
    ]);
    const expectedRuntimeOptions = expect.objectContaining({
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "recorded-gateway",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        OPENSHELL_WORKSPACE: "default",
      }),
      replaceEnv: true,
    });
    expect(capture.mock.calls[0][1]).toEqual(expectedRuntimeOptions);
    expect(capture.mock.calls[1][1]).toEqual(expectedRuntimeOptions);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "alpha",
      expect.stringContaining("nemoclaw-openclaw-post-upgrade-doctor-v2"),
      30_000,
      { runtimeSelection },
    );
    expect(execute.mock.calls[1]?.[1]).toContain("nemoclaw-openclaw-post-upgrade-doctor-ready-v1");
    expect(execute.mock.calls[3]?.[1]).toBe(buildOpenClawPostUpgradeDoctorReleaseCommand());
    expect(execute.mock.calls[4]?.[1]).not.toContain("curl");
    expect(execute.mock.calls[5]?.[1]).not.toContain("curl");
    expect(execute.mock.calls[6]?.[1]).toContain("curl");
    expect(execute.mock.calls[7]?.[1]).not.toContain("curl");
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("enters a distinct backup gate without requesting doctor", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const capture = vi.fn((_args: readonly string[], _options: Record<string, unknown>) => ({
      status: 0,
      output: "",
    }));
    const deps = {
      captureOpenshell: capture as never,
      executeSandboxExecCommand: execute,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    };

    await expect(beginOpenClawBackupQuiesce("alpha", undefined, deps)).resolves.toEqual({
      ok: true,
      window: { sandboxName: "alpha", kind: "backup" },
    });

    expect(execute.mock.calls[0]?.[1]).toContain("nemoclaw-openclaw-backup-quiesce-v1");
    expect(execute.mock.calls[0]?.[1]).not.toContain("post-upgrade-doctor-v2");
    expect(execute.mock.calls[1]?.[1]).toContain("nemoclaw-openclaw-backup-quiesce-v1");
    expect(capture.mock.calls.map((call) => call[0])).toEqual([
      ["sandbox", "stop", "alpha"],
      ["sandbox", "start", "alpha"],
    ]);
  });

  it("waits for a fresh doctor receipt after promoting restored state", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 23, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const deps = {
      captureOpenshell: vi.fn() as never,
      executeSandboxExecCommand: execute,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    };

    await expect(
      promoteOpenClawBackupQuiesceToPostRestoreDoctor(
        { sandboxName: "alpha", kind: "backup" },
        deps,
      ),
    ).resolves.toEqual({ ok: true, window: { sandboxName: "alpha" } });

    expect(execute.mock.calls[0]?.[1]).toBe(buildOpenClawBackupQuiesceDoctorPromotionCommand());
    expect(execute.mock.calls[1]?.[1]).toContain("nemoclaw-openclaw-post-upgrade-doctor-v2");
    expect(execute.mock.calls[1]?.[1]).toContain("nemoclaw-openclaw-post-upgrade-doctor-ready-v1");
    expect(deps.sleep).toHaveBeenCalledOnce();
  });

  it("proves delete-edge release consumption without waiting for gateway health", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 41, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const deps = {
      captureOpenshell: vi.fn() as never,
      executeSandboxExecCommand: execute,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    };

    await expect(
      releaseOpenClawPostRestoreDoctorForDelete({ sandboxName: "alpha" }, deps),
    ).resolves.toEqual({ ok: true });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "alpha",
      buildOpenClawPostUpgradeDoctorReleaseCommand(),
      30_000,
      {},
    );
    expect(execute.mock.calls[1]?.[1]).not.toContain("curl");
    expect(execute.mock.calls[2]?.[1]).not.toContain("curl");
    expect(deps.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.sleep).toHaveBeenCalledOnce();
  });

  it("retires the delete-edge gate before stopping the source sandbox", async () => {
    const execute = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
    const capture = vi.fn(() => ({ status: 0, output: "" }));
    const deps = {
      captureOpenshell: capture as never,
      executeSandboxExecCommand: execute,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    };

    await expect(
      retireOpenClawPostRestoreDoctorForDelete({ sandboxName: "alpha", kind: "backup" }, deps),
    ).resolves.toEqual({ ok: true });

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      buildOpenClawPostUpgradeDoctorDeleteRetirementCommand("nemoclaw-openclaw-backup-quiesce-v1"),
      30_000,
      {},
    );
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["sandbox", "stop", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]!);
  });

  it("keeps filesystem gates direct and probes health through the OpenShell network namespace", async () => {
    const execute = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
    const executePrivileged = vi.fn(
      (_sandboxName: string, _command: readonly string[], _timeout: number) => ({
        status: 0,
        stdout: "",
        stderr: "",
      }),
    );
    const capture = vi.fn(() => ({ status: 0, output: "" }));
    const deps = {
      captureOpenshell: capture as never,
      executePrivilegedSandboxCommand: executePrivileged,
      executeSandboxExecCommand: execute,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    };

    const begun = await beginOpenClawPostRestoreDoctor("alpha", undefined, deps);
    expect(begun).toEqual({ ok: true, window: { sandboxName: "alpha" } });
    await expect(
      finishOpenClawPostRestoreDoctor(
        (begun as { ok: true; window: Parameters<typeof finishOpenClawPostRestoreDoctor>[0] })
          .window,
        deps,
      ),
    ).resolves.toEqual({ ok: true });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      "alpha",
      expect.not.stringContaining("curl"),
      30_000,
      {},
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "alpha",
      expect.stringContaining("curl"),
      expect.any(Number),
      {},
    );
    expect(executePrivileged).toHaveBeenCalledTimes(5);
    const expectedDirectCall = [
      "alpha",
      ["/bin/sh", "-lc", expect.stringContaining('/usr/bin/setpriv --reuid="$uid" --regid="$gid"')],
      expect.any(Number),
    ];
    expect(executePrivileged.mock.calls).toEqual([
      expectedDirectCall,
      expectedDirectCall,
      expectedDirectCall,
      expectedDirectCall,
      expectedDirectCall,
    ]);
    expect(executePrivileged.mock.calls[0]?.[1][2]).toContain("curl");
    expect(executePrivileged.mock.calls[1]?.[1][2]).not.toContain("curl");
    expect(executePrivileged.mock.calls[2]?.[1][2]).not.toContain("curl");
    expect(executePrivileged.mock.calls[3]?.[1][2]).not.toContain("curl");
    expect(executePrivileged.mock.calls[4]?.[1][2]).not.toContain("curl");
  });

  it("does not restart when the one-shot marker cannot be persisted", async () => {
    const capture = vi.fn();

    await expect(
      beginOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: vi.fn(async () => ({
          status: 1,
          stdout: "",
          stderr: "marker write failed",
        })),
        now: () => 0,
        sleep: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({
      ok: false,
      stage: "mark",
      detail: "could not persist the one-shot post-upgrade doctor request",
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    {
      start: { status: 0, output: "" },
      stop: { status: 9, output: "stop failed" },
    },
    {
      start: { status: 9, output: "start failed" },
      stop: { status: 0, output: "" },
    },
  ])(
    "accepts an exact ready receipt after an ambiguous lifecycle result",
    async ({ start, stop }) => {
      const capture = vi.fn().mockReturnValueOnce(stop).mockReturnValueOnce(start);

      await expect(
        beginOpenClawPostRestoreDoctor("alpha", undefined, {
          captureOpenshell: capture as never,
          executeSandboxExecCommand: vi.fn(async () => ({ status: 0, stdout: "", stderr: "" })),
          now: () => 0,
          sleep: vi.fn(async () => undefined),
        }),
      ).resolves.toEqual({ ok: true, window: { sandboxName: "alpha" } });
      expect(capture).toHaveBeenCalledTimes(2);
    },
  );

  it("accepts the exact ready receipt when the stop client throws after committing", async () => {
    const capture = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("response lost after stop");
      })
      .mockReturnValueOnce({ status: 0, output: "" });

    await expect(
      beginOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: vi.fn(async () => ({ status: 0, stdout: "", stderr: "" })),
        now: () => 0,
        sleep: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ ok: true, window: { sandboxName: "alpha" } });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("fails closed when startup never proves the doctor maintenance window", async () => {
    let currentMs = 0;
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockImplementation(async (_sandboxName, command: string) => ({
        status: command.includes("nemoclaw-openclaw-post-upgrade-doctor-abort-v1") ? 0 : 20,
        stdout: "",
        stderr: "",
      }));

    await expect(
      beginOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: vi.fn(() => ({ status: 0, output: "" })) as never,
        executeSandboxExecCommand: execute,
        now: () => currentMs,
        sleep: vi.fn(async (seconds: number) => {
          currentMs += seconds * 1_000;
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      stage: "doctor",
      detail: "startup did not prove doctor completion with the gateway held down",
    });
    expect(currentMs).toBe(3 * 60_000);
  });

  it("does not replay startup after an unready replacement and stops the aborted sandbox", async () => {
    let currentMs = 0;
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockImplementation(async () => ({
        status: currentMs >= 180_000 ? 0 : 20,
        stdout: "",
        stderr: "",
      }));
    const capture = vi.fn((_args: readonly string[], _options: Record<string, unknown>) => ({
      status: 0,
      output: "",
    }));

    await expect(
      beginOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: execute,
        now: () => currentMs,
        sleep: vi.fn(async (seconds: number) => {
          currentMs += seconds * 1_000;
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      stage: "doctor",
      detail: "startup did not prove doctor completion with the gateway held down",
    });
    expect(capture.mock.calls.map((call) => call[0])).toEqual([
      ["sandbox", "stop", "alpha"],
      ["sandbox", "start", "alpha"],
      ["sandbox", "stop", "alpha"],
    ]);
  });

  it("reconciles a nonzero abort stop from the observed stopped phase", async () => {
    const capture = vi.fn(() => ({ status: 9, output: "response lost" }));
    const lookupSandbox = vi.fn(async () => ({
      result: {
        ok: true as const,
        value: {
          state: "present" as const,
          sandbox: { name: "alpha", phase: "Stopped", readiness: "not_ready" as const },
        },
      },
      displayOutput: "",
    }));

    await expect(
      abortOpenClawPostRestoreDoctor(
        { sandboxName: "alpha" },
        {
          captureOpenshell: capture as never,
          executeSandboxExecCommand: vi.fn(async () => ({
            status: 0,
            stdout: "",
            stderr: "",
          })),
          lookupSandbox,
          now: () => 0,
          sleep: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["sandbox", "stop", "alpha"],
      expect.any(Object),
    );
    expect(lookupSandbox).toHaveBeenCalledOnce();
  });

  it("caps the maintenance probe to the remaining reconciliation budget", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(179_000);

    await expect(
      beginOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: vi.fn(() => ({ status: 0, output: "" })) as never,
        executeSandboxExecCommand: execute,
        now,
        sleep: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(execute.mock.calls[1]?.[2]).toBe(1_000);
  });

  it("returns redacted OpenShell startup logs when the released gateway never serves", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValue({ status: 42, stdout: "", stderr: "" });
    let now = 0;
    const collectFailureLogs = vi.fn(async () => [
      "[setup] OpenClaw post-upgrade offline restore released gateway launch",
      "[gateway] startup failed after restored-state validation",
    ]);
    const collectRuntimeFailureLogs = vi.fn(async () => [
      "gateway startup failed: restored plugin state is invalid",
    ]);

    await expect(
      finishOpenClawPostRestoreDoctor(
        {
          sandboxName: "alpha",
          runtimeSelection: { gatewayName: "recorded-gateway", workspace: "default" },
        },
        {
          captureOpenshell: vi.fn() as never,
          collectFailureLogs,
          collectRuntimeFailureLogs,
          executeSandboxExecCommand: execute,
          now: () => now,
          sleep: vi.fn(async () => {
            now = 180_000;
          }),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      stage: "restart",
      detail: expect.stringMatching(
        /gateway startup failed: restored plugin state is invalid[\s\S]*\[gateway\] startup failed after restored-state validation/u,
      ),
    });
    expect(collectRuntimeFailureLogs).toHaveBeenCalledExactlyOnceWith("alpha", {
      gatewayName: "recorded-gateway",
      workspace: "default",
    });
    expect(collectFailureLogs).toHaveBeenCalledExactlyOnceWith("alpha", {
      kind: "named",
      gatewayName: "recorded-gateway",
    });
  });

  it("keeps the gateway gated when the verified release cannot be published", async () => {
    const execute = vi.fn(async () => ({ status: 35, stdout: "", stderr: "" }));

    await expect(
      finishOpenClawPostRestoreDoctor(
        { sandboxName: "alpha" },
        {
          captureOpenshell: vi.fn() as never,
          executeSandboxExecCommand: execute,
          now: () => 0,
          sleep: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      stage: "release",
      detail: "could not release the verified post-upgrade maintenance window",
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe.each([
  "cancelled",
  "timeout",
  "capture",
  "invocation",
  "unavailable",
  "malformed",
] as const)("doctor maintenance transport failure: %s", (kind) => {
  it("reports an unverified marker without restarting or trying privilege", async () => {
    const error = new SandboxCommandTransportError(kind);
    const execute = vi.fn().mockRejectedValue(error);
    const capture = vi.fn();
    const privileged = vi.fn();
    await expect(
      beginOpenClawPostRestoreDoctor("alpha", undefined, {
        captureOpenshell: capture as never,
        executeSandboxExecCommand: execute,
        executePrivilegedSandboxCommand: privileged,
        now: () => 0,
        sleep: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, stage: "mark", detail: error.message });
    expect(execute).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(privileged).not.toHaveBeenCalled();
  });

  it("reports an unverified native release without polling or retrying", async () => {
    const execute = vi.fn().mockRejectedValue(new SandboxCommandTransportError(kind));
    const capture = vi.fn();
    const sleep = vi.fn();
    await expect(
      releaseOpenClawPostRestoreDoctorForDelete(
        { sandboxName: "alpha" },
        {
          captureOpenshell: capture as never,
          executeSandboxExecCommand: execute,
          now: () => 0,
          sleep,
        },
      ),
    ).resolves.toMatchObject({ ok: false, stage: "release" });
    expect(execute).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

it("propagates unexpected maintenance authority errors", async () => {
  const error = new Error("maintenance authority refused");
  const deps = {
    captureOpenshell: vi.fn() as never,
    executeSandboxExecCommand: vi.fn().mockRejectedValue(error),
    now: () => 0,
    sleep: vi.fn(),
  };
  await expect(beginOpenClawPostRestoreDoctor("alpha", undefined, deps)).rejects.toBe(error);
  await expect(
    releaseOpenClawPostRestoreDoctorForDelete({ sandboxName: "alpha" }, deps),
  ).rejects.toBe(error);
});
