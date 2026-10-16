// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const sources = [
  "nemoclaw-blueprint/blueprint.yaml",
  "scripts/install-openshell.sh",
  "scripts/brev-launchable-ci-cpu.sh",
  "src/lib/onboard/docker-driver-gateway-runtime.ts",
  "src/lib/onboard/openshell-feature-gate.ts",
  "src/lib/onboard/openshell-version.ts",
  "package.json",
  "package-lock.json",
  "ci/reviewed-npm-audit.json",
];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.openSync).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "protected-openshell-workspace-"));
  roots.push(root);
  const trustedRoot = join(root, "trusted");
  const candidateRoot = join(root, "candidate");
  for (const target of [trustedRoot, candidateRoot]) {
    fs.mkdirSync(target);
    git(target, "init", "--quiet");
    for (const path of sources) {
      const file = join(target, path);
      fs.mkdirSync(dirname(file), { recursive: true });
      fs.copyFileSync(new URL(`../../../${path}`, import.meta.url), file);
      fs.chmodSync(file, path.endsWith(".sh") ? 0o755 : 0o644);
    }
    fs.writeFileSync(join(target, "controller.txt"), "trusted fixture\n");
  }
  fs.writeFileSync(
    join(trustedRoot, "nemoclaw-blueprint/blueprint.yaml"),
    'name: fixture\nmin_openshell_version: "0.0.1"\nmax_openshell_version: "0.0.1"\n',
  );
  fs.writeFileSync(
    join(trustedRoot, "src/lib/onboard/openshell-version.ts"),
    'export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "0.0.1";\n',
  );
  git(trustedRoot, "add", ".");
  git(trustedRoot, "commit", "--quiet", "-m", "fixture");
  git(candidateRoot, "add", ".");
  git(candidateRoot, "commit", "--quiet", "-m", "fixture");
  return {
    trustedRoot,
    candidateRoot,
    workflowSha: git(trustedRoot, "rev-parse", "HEAD"),
    candidateSha: git(candidateRoot, "rev-parse", "HEAD"),
  };
}

describe("protected OpenShell workspace", () => {
  it("binds the workflow CLI to dispatch commits and emits records for each phase", () => {
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

  it("prepares candidate pins, verifies their bytes, and restores the trusted checkout", () => {
    const input = fixture();
    const prepared = manageProtectedOpenShellWorkspace("prepare", input);
    expect(prepared).toMatchObject({
      workflowSha: input.workflowSha,
      candidateSha: input.candidateSha,
      operation: "prepare",
    });
    expect(prepared.files).toHaveLength(7);
    expect(manageProtectedOpenShellWorkspace("verify", input)).toEqual({
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
    manageProtectedOpenShellWorkspace("restore", input);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
    expect(() => manageProtectedOpenShellWorkspace("restore", input)).not.toThrow();
  });

  it.each(["workflowSha", "candidateSha"] as const)(
    "rejects a mismatched %s before changing files",
    (key) => {
      const input = fixture();
      input[key] = "a".repeat(40);
      expect(() => manageProtectedOpenShellWorkspace("prepare", input)).toThrow(/dispatch commit/);
      expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
    },
  );

  it("uses committed candidate blobs instead of mutable worktree content", () => {
    const input = fixture();
    fs.appendFileSync(
      join(input.candidateRoot, "scripts/install-openshell.sh"),
      "\nunreviewed_operation\n",
    );
    const result = manageProtectedOpenShellWorkspace("prepare", input);
    expect(result.releaseVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => manageProtectedOpenShellWorkspace("verify", input)).not.toThrow();
  });

  it("rejects committed unreviewed candidate operations", () => {
    const input = fixture();
    fs.appendFileSync(
      join(input.candidateRoot, "scripts/install-openshell.sh"),
      "\nunreviewed_operation\n",
    );
    git(input.candidateRoot, "add", ".");
    git(input.candidateRoot, "commit", "--quiet", "-m", "unreviewed");
    input.candidateSha = git(input.candidateRoot, "rev-parse", "HEAD");
    expect(() => manageProtectedOpenShellWorkspace("prepare", input)).toThrow(/template/);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it.each(["prepare", "verify", "restore"] as const)(
    "rejects unrelated controller edits during %s",
    (operation) => {
      const input = fixture();
      fs.writeFileSync(join(input.trustedRoot, "controller.txt"), "modified");
      expect(() => manageProtectedOpenShellWorkspace(operation, input)).toThrow(/Unrelated/);
      expect(fs.readFileSync(join(input.trustedRoot, "controller.txt"), "utf8")).toBe("modified");
    },
  );

  it.each(["file", "parent"])("rejects a symlinked destination %s without following it", (kind) => {
    const input = fixture();
    const path = join(
      input.trustedRoot,
      kind === "file" ? "scripts/install-openshell.sh" : "scripts",
    );
    const moved = `${path}.retained`;
    fs.renameSync(path, moved);
    fs.symlinkSync(moved, path);
    expect(() => manageProtectedOpenShellWorkspace("prepare", input)).toThrow(/Unsafe/);
    expect(fs.readlinkSync(path)).toBe(moved);
  });

  it("rejects tampering before verification or restoration", () => {
    const input = fixture();
    manageProtectedOpenShellWorkspace("prepare", input);
    const path = join(input.trustedRoot, "src/lib/onboard/openshell-version.ts");
    fs.appendFileSync(path, "\nunreviewed_operation();\n");
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    expect(() => manageProtectedOpenShellWorkspace("verify", input)).toThrow(/Unexpected verify/);
    expect(() => manageProtectedOpenShellWorkspace("restore", input)).toThrow(/Unexpected restore/);
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
    expect(() => manageProtectedOpenShellWorkspace("prepare", input)).toThrow(/Unsafe/);
    expect(fs.readlinkSync(path)).toBe(retained);
    expect(fs.statSync(retained)).toMatchObject({
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
  });

  it("rejects a hard-linked destination and closes its opened descriptor", () => {
    const input = fixture();
    const path = join(input.trustedRoot, "scripts/install-openshell.sh");
    fs.linkSync(path, `${path}.retained`);
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.closeSync).mockClear();
    expect(() => manageProtectedOpenShellWorkspace("prepare", input)).toThrow(/Unsafe/);
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
    expect(() => manageProtectedOpenShellWorkspace("prepare", input)).toThrow(
      /fixture replacement failure/,
    );
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });
});
