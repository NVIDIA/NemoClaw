// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identity } from "../../helpers/candidate-openshell-trust";
import {
  CANDIDATE_OPENSHELL_SOURCES,
  CANDIDATE_OPENSHELL_TRUST_PATH,
} from "../../../tools/e2e/candidate-openshell-trust.mts";
import { fixture, approvedFixture, git, roots } from "../../support/protected-openshell-workspace";
import { manageProtectedOpenShellWorkspace } from "../../../tools/e2e/protected-openshell-workspace.mts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    renameSync: vi.fn(original.renameSync),
    openSync: vi.fn(original.openSync),
    closeSync: vi.fn(original.closeSync),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.openSync).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("protected OpenShell workspace", () => {
  it("projects independently approved installer and feature gate templates and rechecks each phase", async () => {
    const { input, request } = approvedFixture();
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).resolves.toMatchObject({
      operation: "prepare",
    });
    expect(
      request.mock.calls.filter(([path]) => path === "/repos/NVIDIA/NemoClaw/pulls/123"),
    ).toHaveLength(2);
    request.mockClear();
    await expect(manageProtectedOpenShellWorkspace("verify", input)).resolves.toMatchObject({
      operation: "verify",
    });
    expect(
      request.mock.calls.filter(([path]) => path === "/repos/NVIDIA/NemoClaw/pulls/123"),
    ).toHaveLength(2);
    request.mockClear();
    await expect(manageProtectedOpenShellWorkspace("restore", input)).resolves.toMatchObject({
      operation: "restore",
    });
    expect(
      request.mock.calls.filter(([path]) => path === "/repos/NVIDIA/NemoClaw/pulls/123"),
    ).toHaveLength(2);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it.each<[string, (value: ReturnType<typeof approvedFixture>) => void, RegExp]>([
    [
      "missing",
      ({ approval }) => {
        approval.approvals.splice(0);
      },
      /approval|decision/i,
    ],
    [
      "stale",
      ({ approval }) => {
        approval.approvals[0]!.body = `NemoClaw-Upgrade-E2E: approve ${identity.candidateSha} ${identity.baseSha}`;
      },
      /approval|decision/i,
    ],
    [
      "registry",
      ({ approval }) => {
        approval.files[CANDIDATE_OPENSHELL_TRUST_PATH] += "\n";
      },
      /Committed candidate registry differs/,
    ],
    [
      "source",
      ({ approval }) => {
        approval.files[CANDIDATE_OPENSHELL_SOURCES.blueprintSource] += "\n";
      },
      /Committed candidate source differs/,
    ],
  ])("rejects %s candidate approval before mutation", async (_scenario, mutate, expected) => {
    const value = approvedFixture();
    mutate(value);
    await expect(manageProtectedOpenShellWorkspace("prepare", value.input)).rejects.toThrow(
      expected,
    );
    expect(git(value.input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects an unapproved feature gate template before mutation", async () => {
    const { input, approval } = approvedFixture();
    fs.appendFileSync(
      join(input.candidateRoot, "src/lib/onboard/openshell-feature-gate.ts"),
      "\nunreviewed_operation();\n",
    );
    git(input.candidateRoot, "add", ".");
    git(input.candidateRoot, "commit", "--quiet", "-m", "unapproved feature");
    input.candidateSha = git(input.candidateRoot, "rev-parse", "HEAD");
    approval.approvals[0]!.body = `NemoClaw-Upgrade-E2E: approve ${input.candidateSha} ${identity.baseSha}`;
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
      /feature gate operational template/,
    );
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects revoked approval before verification and leaves projected files untouched", async () => {
    const { input, approval } = approvedFixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    approval.approvals[0]!.body = `NemoClaw-Upgrade-E2E: revoke ${input.candidateSha} ${identity.baseSha}`;
    await expect(manageProtectedOpenShellWorkspace("verify", input)).rejects.toThrow();
    await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow();
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
  });

  it("binds the workflow CLI to dispatch commits and emits records for each phase", async () => {
    const input = fixture();
    const command = fileURLToPath(
      new URL("../../../tools/e2e/protected-openshell-workspace.mts", import.meta.url),
    );
    const options = {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: input.trustedRoot,
        NEMOCLAW_E2E_TESTED_ROOT: input.candidateRoot,
        CHECKOUT_SHA: input.candidateSha,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA: input.workflowSha,
      },
    } as const;
    const expected = {
      workflowSha: input.workflowSha,
      candidateSha: input.candidateSha,
    };
    const prepared = execFileSync(process.execPath, [command, "prepare"], options);
    expect(JSON.parse(prepared)).toMatchObject({ ...expected, operation: "prepare" });
    const verified = execFileSync(process.execPath, [command, "verify"], options);
    expect(JSON.parse(verified)).toMatchObject({ ...expected, operation: "verify" });
    const restored = execFileSync(process.execPath, [command, "restore"], options);
    expect(JSON.parse(restored)).toMatchObject({ ...expected, operation: "restore" });
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it("prepares candidate pins, verifies their bytes, and restores the trusted checkout", async () => {
    const input = fixture();
    const prepared = await manageProtectedOpenShellWorkspace("prepare", input);
    expect(prepared).toMatchObject({
      workflowSha: input.workflowSha,
      candidateSha: input.candidateSha,
      operation: "prepare",
    });
    expect(prepared.files).toHaveLength(7);
    expect(await manageProtectedOpenShellWorkspace("verify", input)).toEqual({
      ...prepared,
      operation: "verify",
    });
    const actualDigests = prepared.files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256")
        .update(fs.readFileSync(join(input.trustedRoot, file.path)))
        .digest("hex"),
    }));
    expect(actualDigests).toEqual(prepared.files);
    await manageProtectedOpenShellWorkspace("restore", input);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
    await expect(manageProtectedOpenShellWorkspace("restore", input)).resolves.toBeDefined();
  });

  it.each(["workflowSha", "candidateSha"] as const)(
    "rejects a mismatched %s before changing files",
    async (key) => {
      const input = fixture();
      input[key] = "a".repeat(40);
      await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
        /dispatch commit/,
      );
      expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
    },
  );

  it("uses committed candidate blobs instead of mutable worktree content", async () => {
    const input = fixture();
    fs.appendFileSync(
      join(input.candidateRoot, "scripts/install-openshell.sh"),
      "\nunreviewed_operation\n",
    );
    const result = await manageProtectedOpenShellWorkspace("prepare", input);
    expect(result.releaseVersion).toMatch(/^\d+\.\d+\.\d+$/);
    await expect(manageProtectedOpenShellWorkspace("verify", input)).resolves.toBeDefined();
  });

  it("rejects committed unreviewed candidate operations", async () => {
    const input = fixture();
    fs.appendFileSync(
      join(input.candidateRoot, "scripts/install-openshell.sh"),
      "\nunreviewed_operation\n",
    );
    git(input.candidateRoot, "add", ".");
    git(input.candidateRoot, "commit", "--quiet", "-m", "unreviewed");
    input.candidateSha = git(input.candidateRoot, "rev-parse", "HEAD");
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(/template/);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it.each(["prepare", "verify", "restore"] as const)(
    "rejects unrelated controller edits during %s",
    async (operation) => {
      const input = fixture();
      fs.writeFileSync(join(input.trustedRoot, "controller.txt"), "modified");
      await expect(manageProtectedOpenShellWorkspace(operation, input)).rejects.toThrow(
        /Unrelated/,
      );
      expect(fs.readFileSync(join(input.trustedRoot, "controller.txt"), "utf8")).toBe("modified");
    },
  );

  it.each(["file", "parent"])(
    "rejects a symlinked destination %s without following it",
    async (kind) => {
      const input = fixture();
      const path = join(
        input.trustedRoot,
        kind === "file" ? "scripts/install-openshell.sh" : "scripts",
      );
      const moved = `${path}.retained`;
      fs.renameSync(path, moved);
      fs.symlinkSync(moved, path);
      await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(/Unsafe/);
      expect(fs.readlinkSync(path)).toBe(moved);
    },
  );

  it("rejects tampering before verification or restoration", async () => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const path = join(input.trustedRoot, "src/lib/onboard/openshell-version.ts");
    fs.appendFileSync(path, "\nunreviewed_operation();\n");
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    await expect(manageProtectedOpenShellWorkspace("verify", input)).rejects.toThrow(
      /Unexpected verify/,
    );
    await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(
      /Unexpected restore/,
    );
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
  });

  it("rejects a destination replaced with a symlink immediately before opening", async () => {
    const input = fixture();
    const path = join(input.trustedRoot, "scripts/install-openshell.sh");
    const retained = `${path}.retained`;
    const before = fs.statSync(path);
    const { openSync: original } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementationOnce((file, flags, mode) => {
      expect(file).toBe(path);
      fs.renameSync(path, retained);
      fs.symlinkSync(retained, path);
      return original(file, flags, mode);
    });
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(/Unsafe/);
    expect(fs.readlinkSync(path)).toBe(retained);
    expect(fs.statSync(retained)).toMatchObject({
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
  });

  it("rejects a hard-linked destination and closes its opened descriptor", async () => {
    const input = fixture();
    const path = join(input.trustedRoot, "scripts/install-openshell.sh");
    fs.linkSync(path, `${path}.retained`);
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.closeSync).mockClear();
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(/Unsafe/);
    const opened = vi.mocked(fs.openSync).mock.results.map((result) => result.value);
    expect(opened.length).toBeGreaterThan(0);
    expect(vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd)).toEqual(opened);
    expect(fs.statSync(path).nlink).toBe(2);
  });

  it("rolls back an incomplete prepare when a later replacement fails", async () => {
    const input = fixture();
    const { renameSync: original } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.renameSync)
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw new Error("fixture replacement failure");
      });
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
      /fixture replacement failure/,
    );
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });
});
