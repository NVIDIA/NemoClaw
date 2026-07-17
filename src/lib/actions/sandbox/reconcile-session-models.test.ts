// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeSandboxCommand } from "./process-recovery";
import {
  buildSessionStoreReplaceCommand,
  reconcilePinnedSessionModels,
  reconcileStalePinnedSessionModelsAfterRebuild,
} from "./reconcile-session-models";

vi.mock("./process-recovery", () => ({ executeSandboxCommand: vi.fn() }));

const executeSandboxCommandMock = vi.mocked(executeSandboxCommand);

beforeEach(() => {
  executeSandboxCommandMock.mockReset();
});

function store(entries: Record<string, unknown>): string {
  return JSON.stringify(entries);
}

function readRegularFileNoFollow(filePath: string): string {
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = fstatSync(descriptor);
    expect(metadata.isFile(), `${filePath} must be a regular file`).toBe(true);
    expect(metadata.nlink, `${filePath} must have exactly one link`).toBe(1);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

describe("reconcilePinnedSessionModels (#7102)", () => {
  const primary = "inference/nvidia/llama-3.3-nemotron-super-49b-v1.5";

  it("clears a managed pin that no longer matches the current default", () => {
    const raw = store({
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "inference",
        model: "meta/llama-3.1-8b-instruct",
      },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.changed).toBe(true);
    expect(result.clearedSessionKeys).toEqual(["agent:main:main"]);
    const parsed = JSON.parse(result.content);
    expect(parsed["agent:main:main"].model).toBeUndefined();
    expect(parsed["agent:main:main"].modelProvider).toBeUndefined();
    // Non-model fields are preserved.
    expect(parsed["agent:main:main"].sessionId).toBe("s1");
  });

  it("leaves a session already on the current default untouched", () => {
    const raw = store({
      "agent:main:main": {
        modelProvider: "inference",
        model: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(raw);
  });

  it("leaves an intentional non-managed provider pin untouched", () => {
    const raw = store({
      "agent:main:main": { modelProvider: "openai", model: "gpt-5.6-terra" },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.changed).toBe(false);
  });

  it("only clears the stale managed sessions in a mixed store", () => {
    const raw = store({
      stale: { modelProvider: "inference", model: "meta/llama-3.1-8b-instruct" },
      current: { modelProvider: "inference", model: "nvidia/llama-3.3-nemotron-super-49b-v1.5" },
      intentional: { modelProvider: "openai", model: "gpt-5.6-terra" },
      unpinned: { sessionId: "x" },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.clearedSessionKeys).toEqual(["stale"]);
    const parsed = JSON.parse(result.content);
    expect(parsed.stale.model).toBeUndefined();
    expect(parsed.current.model).toBe("nvidia/llama-3.3-nemotron-super-49b-v1.5");
    expect(parsed.intentional.model).toBe("gpt-5.6-terra");
    expect(parsed.unpinned.sessionId).toBe("x");
  });

  it("is a no-op when the primary ref is missing", () => {
    const raw = store({
      "agent:main:main": { modelProvider: "inference", model: "meta/llama-3.1-8b-instruct" },
    });
    expect(reconcilePinnedSessionModels(raw, null).changed).toBe(false);
  });

  it("is a no-op on malformed session json", () => {
    expect(reconcilePinnedSessionModels("not json", primary).changed).toBe(false);
    expect(reconcilePinnedSessionModels("[]", primary).changed).toBe(false);
  });

  it("ignores an entry with a non-string model", () => {
    const raw = store({
      "agent:main:main": { modelProvider: "inference", model: 42 },
    });
    expect(reconcilePinnedSessionModels(raw, primary).changed).toBe(false);
  });
});

describe("buildSessionStoreReplaceCommand", () => {
  it("uses no-follow exclusive staging with atomic replacement and cleanup (#7102)", () => {
    const command = buildSessionStoreReplaceCommand(
      "/sandbox/.openclaw/agents/main/sessions/sessions.json",
      '{"new":true}\n',
      '{"old":true}',
    );

    expect(command).toContain("os.O_EXCL");
    expect(command).toContain("python3 -I -c");
    expect(command).toContain("os.O_NOFOLLOW");
    expect(command).toContain("os.fchown(staged_fd, source_stat.st_uid, source_stat.st_gid)");
    expect(command).toContain("os.fchmod(staged_fd, stat.S_IMODE(source_stat.st_mode))");
    expect(command).toContain("os.replace(staged_name, target_name");
    expect(command).toContain("if not installed and staged_name");
    expect(command).toContain("os.unlink(staged_name, dir_fd=parent_fd)");
    expect(command).not.toContain(".nemoclaw-tmp");
  });

  it("atomically replaces a regular store while preserving its metadata (#7102)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nemoclaw-session-reconcile-")));
    try {
      const sessionsPath = join(root, "sessions.json");
      const original = '{"old":true}\n';
      const replacement = '{"new":true}\n';
      writeFileSync(sessionsPath, original, { mode: 0o640 });
      const before = statSync(sessionsPath);

      const result = spawnSync(
        "sh",
        ["-c", buildSessionStoreReplaceCommand(sessionsPath, replacement, original.trim())],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readRegularFileNoFollow(sessionsPath)).toBe(replacement);
      const after = statSync(sessionsPath);
      expect(after.mode & 0o777).toBe(before.mode & 0o777);
      expect(after.uid).toBe(before.uid);
      expect(after.gid).toBe(before.gid);
      expect(readdirSync(root)).toEqual(["sessions.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked store without changing its target (#7102)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nemoclaw-session-reconcile-link-")));
    try {
      const targetPath = join(root, "target.json");
      const sessionsPath = join(root, "sessions.json");
      const original = '{"keep":true}\n';
      writeFileSync(targetPath, original);
      symlinkSync(targetPath, sessionsPath);

      const result = spawnSync(
        "sh",
        [
          "-c",
          buildSessionStoreReplaceCommand(sessionsPath, '{"replace":true}\n', original.trim()),
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(readRegularFileNoFollow(targetPath)).toBe(original);
      expect(readdirSync(root).sort()).toEqual(["sessions.json", "target.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked parent path without changing its target (#7102)", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "nemoclaw-session-reconcile-parent-link-")),
    );
    try {
      const realParent = join(root, "real-sessions");
      const linkedParent = join(root, "linked-sessions");
      const original = '{"keep":true}\n';
      mkdirSync(realParent);
      writeFileSync(join(realParent, "sessions.json"), original);
      symlinkSync(realParent, linkedParent, "dir");

      const result = spawnSync(
        "sh",
        [
          "-c",
          buildSessionStoreReplaceCommand(
            join(linkedParent, "sessions.json"),
            '{"replace":true}\n',
            original.trim(),
          ),
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(readRegularFileNoFollow(join(realParent, "sessions.json"))).toBe(original);
      expect(readdirSync(realParent)).toEqual(["sessions.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses stale source content without changing the store (#7102)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nemoclaw-session-reconcile-race-")));
    try {
      const sessionsPath = join(root, "sessions.json");
      const current = '{"current":true}\n';
      writeFileSync(sessionsPath, current);

      const result = spawnSync(
        "sh",
        [
          "-c",
          buildSessionStoreReplaceCommand(sessionsPath, '{"replacement":true}\n', '{"stale":true}'),
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(readRegularFileNoFollow(sessionsPath)).toBe(current);
      expect(readdirSync(root)).toEqual(["sessions.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reconcileStalePinnedSessionModelsAfterRebuild", () => {
  const primary = "inference/nvidia/llama-3.3-nemotron-super-49b-v1.5";
  const config = JSON.stringify({ agents: { defaults: { model: { primary } } } });
  const staleStore = store({
    "agent:main:main": {
      modelProvider: "inference",
      model: "meta/llama-3.1-8b-instruct",
    },
  });

  it("reads restored state and dispatches a guarded write for stale pins (#7102)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: config, stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: staleStore, stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const log = vi.fn();

    reconcileStalePinnedSessionModelsAfterRebuild("alpha", log);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(3);
    expect(executeSandboxCommandMock.mock.calls[0]).toEqual([
      "alpha",
      "cat /sandbox/.openclaw/openclaw.json 2>/dev/null",
    ]);
    expect(executeSandboxCommandMock.mock.calls[1]).toEqual([
      "alpha",
      "cat /sandbox/.openclaw/agents/main/sessions/sessions.json 2>/dev/null",
    ]);
    expect(log).toHaveBeenLastCalledWith(
      `Session model reconcile: cleared stale pinned model on 1 session(s) so they follow ${primary}`,
    );
  });

  it("stops when the restored config has no primary model (#7102)", () => {
    executeSandboxCommandMock.mockReturnValueOnce({
      status: 0,
      stdout: '{"agents":{"defaults":{}}}',
      stderr: "",
    });
    const log = vi.fn();

    reconcileStalePinnedSessionModelsAfterRebuild("alpha", log);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      "Session model reconcile skipped: could not read agents.defaults.model.primary",
    );
  });

  it("rejects a restored primary model with terminal control characters (#7102)", () => {
    executeSandboxCommandMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        agents: { defaults: { model: { primary: "inference/model\u001b[2J" } } },
      }),
      stderr: "",
    });
    const log = vi.fn();

    reconcileStalePinnedSessionModelsAfterRebuild("alpha", log);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      "Session model reconcile skipped: could not read agents.defaults.model.primary",
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain("\u001b");
  });

  it("stops when the restored session store cannot be read (#7102)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: config, stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "missing" });
    const log = vi.fn();

    reconcileStalePinnedSessionModelsAfterRebuild("alpha", log);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      "Session model reconcile skipped: no session store at /sandbox/.openclaw/agents/main/sessions/sessions.json",
    );
  });

  it("reports an atomic write failure without retrying or claiming success (#7102)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: config, stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: staleStore, stderr: "" })
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "refused" });
    const log = vi.fn();

    reconcileStalePinnedSessionModelsAfterRebuild("alpha", log);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith(
      "Session model reconcile: failed to write /sandbox/.openclaw/agents/main/sessions/sessions.json (status=9)",
    );
    expect(log.mock.calls.flat()).not.toContainEqual(expect.stringContaining("cleared stale"));
  });
});
