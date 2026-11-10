// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as protectedFs from "../../../tools/e2e/protected-openshell-filesystem.mts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identity } from "../../helpers/candidate-openshell-trust";
import {
  CANDIDATE_OPENSHELL_SOURCES,
  CANDIDATE_OPENSHELL_TRUST_PATH,
} from "../../../tools/e2e/candidate-openshell-trust.mts";
import {
  fixture,
  approvedFixture,
  admittedSdkFixture,
  executeWorkflowRestoration,
  git,
  roots,
} from "../../support/protected-openshell-workspace";
import {
  manageProtectedOpenShellWorkspace,
  prepareProtectedOpenShellSdk,
} from "../../../tools/e2e/protected-openshell-workspace.mts";

vi.mock("../../../tools/e2e/protected-openshell-filesystem.mts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../tools/e2e/protected-openshell-filesystem.mts")>();
  return {
    ...original,
    safeFile: vi.fn(original.safeFile),
    replaceSource: vi.fn(original.replaceSource),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("protected OpenShell workspace", () => {
  it("projects independently approved templates and rechecks admission before verification", async () => {
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
    expect(request).not.toHaveBeenCalled();
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
        approval.approvals[0]!.commit_id = identity.candidateSha;
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

  it.each(
    ["candidate", "base"].flatMap((side) =>
      [
        "scripts/audit-reviewed-npm-graph.mts",
        "scripts/lib/reviewed-npm-archive.mts",
        "scripts/lib/reviewed-npm-audit.mts",
        "scripts/lib/repository-input-path.mts",
        "ci/reviewed-npm-audit.json",
      ].map((path) => [side, path] as const),
    ),
  )("rejects %s changes to SDK projection policy %s before mutation", async (side, filename) => {
    const { input, approval, request } = approvedFixture();
    const original = request.getMockImplementation()!;
    const reviewedSha = "d".repeat(40);
    const oldBase = "e".repeat(40);
    const baseSha = input.admission.baseSha;
    approval.approvals[0]!.commit_id = reviewedSha;
    const comparisons = new Map<string, unknown>([
      [
        `/repos/NVIDIA/NemoClaw/compare/${reviewedSha}...${input.candidateSha}?per_page=1`,
        {
          status: "ahead",
          base_commit: { sha: reviewedSha },
          merge_base_commit: { sha: reviewedSha },
          files: side === "candidate" ? [{ filename }] : [],
        },
      ],
      [
        `/repos/NVIDIA/NemoClaw/compare/${baseSha}...${reviewedSha}?per_page=1`,
        {
          status: "diverged",
          base_commit: { sha: baseSha },
          merge_base_commit: { sha: oldBase },
        },
      ],
      [
        `/repos/NVIDIA/NemoClaw/compare/${oldBase}...${baseSha}?per_page=1`,
        {
          status: "ahead",
          base_commit: { sha: oldBase },
          merge_base_commit: { sha: oldBase },
          files: side === "base" ? [{ filename }] : [],
        },
      ],
    ]);
    request.mockImplementation(async (path) => comparisons.get(path) ?? original(path));
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
      /PR approval covering/,
    );
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
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
    approval.approvals[0]!.commit_id = input.candidateSha;
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
      /feature gate operational template/,
    );
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects revoked approval for verification but restores trusted files without admission", async () => {
    const { input, approval, request } = approvedFixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    approval.approvals[0]!.state = "DISMISSED";
    await expect(manageProtectedOpenShellWorkspace("verify", input)).rejects.toThrow(
      "Candidate upgrade needs an independent maintainer's PR approval covering its inputs and policy",
    );
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
    request.mockClear();
    await manageProtectedOpenShellWorkspace("restore", { ...input, admission: undefined });
    await manageProtectedOpenShellWorkspace("restore", { ...input, admission: undefined });
    expect(request).not.toHaveBeenCalled();
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it.each<
    [
      string,
      (receipt: {
        workflowSha: string;
        candidateSha: string;
        trustedRoot: string;
        files: { path: string; originalSha256: string }[];
      }) => void,
    ]
  >([
    [
      "workflowSha",
      (receipt) => {
        receipt.workflowSha = "invalid";
      },
    ],
    [
      "candidateSha",
      (receipt) => {
        receipt.candidateSha = "invalid";
      },
    ],
    [
      "trustedRoot",
      (receipt) => {
        receipt.trustedRoot = "invalid";
      },
    ],
    [
      "path",
      (receipt) => {
        receipt.files[0]!.path = "../outside";
      },
    ],
    [
      "duplicate",
      (receipt) => {
        receipt.files[1] = receipt.files[0]!;
      },
    ],
    [
      "originalSha256",
      (receipt) => {
        receipt.files[0]!.originalSha256 = "0".repeat(64);
      },
    ],
  ])(
    "rejects a recovery receipt with altered %s before writing sources",
    async (_field, mutate) => {
      const input = fixture();
      await manageProtectedOpenShellWorkspace("prepare", input);
      const receiptPath = join(input.trustedRoot, ".git/nemoclaw-openshell-projection.json");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      mutate(receipt);
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      const before = git(input.trustedRoot, "diff", "--no-ext-diff");
      await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(
        /Invalid protected OpenShell recovery/,
      );
      expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
    },
  );

  it.each<[string, (receiptPath: string) => void]>([
    ["missing", (receiptPath) => fs.unlinkSync(receiptPath)],
    [
      "symlink",
      (receiptPath) => {
        fs.renameSync(receiptPath, `${receiptPath}.retained`);
        fs.symlinkSync(`${receiptPath}.retained`, receiptPath);
      },
    ],
    ["hardlink", (receiptPath) => fs.linkSync(receiptPath, `${receiptPath}.retained`)],
    ["public", (receiptPath) => fs.chmodSync(receiptPath, 0o644)],
    ["malformed", (receiptPath) => fs.writeFileSync(receiptPath, "{")],
  ])("rejects a %s recovery receipt without changing sources", async (_kind, mutate) => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const receiptPath = join(input.trustedRoot, ".git/nemoclaw-openshell-projection.json");
    mutate(receiptPath);
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(
      /Unsafe protected OpenShell file|Invalid protected OpenShell recovery/,
    );
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
  });

  it.each([
    ["file", "scripts/install-openshell.sh", /Unsafe/],
    ["parent", "scripts", /Unrelated changes/],
  ] as const)(
    "rejects a symlinked destination %s during restoration",
    async (_kind, file, diagnostic) => {
      const input = fixture();
      await manageProtectedOpenShellWorkspace("prepare", input);
      const destination = join(input.trustedRoot, file);
      const retained = `${destination}.retained`;
      fs.renameSync(destination, retained);
      fs.symlinkSync(retained, destination);
      const before = git(input.trustedRoot, "diff", "--no-ext-diff");
      await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(diagnostic);
      expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
      expect(fs.readlinkSync(destination)).toBe(retained);
    },
  );

  it("rejects a hard-linked projected destination during restoration", async () => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const destination = join(input.trustedRoot, "scripts/install-openshell.sh");
    fs.linkSync(destination, `${destination}.retained`);
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(/Unsafe/);
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
    expect(fs.statSync(destination).nlink).toBe(2);
  });

  it("resumes a partially completed restoration without restoring candidate bytes", async () => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const versionPath = "src/lib/onboard/openshell-version.ts";
    const trustedVersion = git(input.trustedRoot, "show", `${input.workflowSha}:${versionPath}`);
    const { replaceSource: original } = await vi.importActual<
      typeof import("../../../tools/e2e/protected-openshell-filesystem.mts")
    >("../../../tools/e2e/protected-openshell-filesystem.mts");
    vi.mocked(protectedFs.replaceSource)
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw new Error("fixture recovery failure");
      });
    await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(
      /fixture recovery failure/,
    );
    expect(fs.readFileSync(join(input.trustedRoot, versionPath), "utf8").trim()).toBe(
      trustedVersion,
    );
    await manageProtectedOpenShellWorkspace("restore", input);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it("prepares a new projection after completed restoration", async () => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    await manageProtectedOpenShellWorkspace("restore", input);
    await manageProtectedOpenShellWorkspace("prepare", input);
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).not.toBe("");
  });

  it("rejects a parent swapped between restore validation and replacement and can recover", async () => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    const parent = join(input.trustedRoot, "src/lib/onboard");
    const outside = join(input.candidateRoot, "outside");
    fs.mkdirSync(outside);
    const sentinel = join(outside, "openshell-version.ts");
    fs.writeFileSync(sentinel, "external sentinel");
    const { replaceSource: original } = await vi.importActual<
      typeof import("../../../tools/e2e/protected-openshell-filesystem.mts")
    >("../../../tools/e2e/protected-openshell-filesystem.mts");
    vi.mocked(protectedFs.replaceSource).mockImplementationOnce((...args) => {
      expect(args[1]).toBe("src/lib/onboard/openshell-version.ts");
      fs.renameSync(parent, `${parent}.held`);
      fs.symlinkSync(outside, parent);
      return original(...args);
    });
    await expect(manageProtectedOpenShellWorkspace("restore", input)).rejects.toThrow(/Unsafe/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("external sentinel");
    expect(fs.readdirSync(outside)).toEqual(["openshell-version.ts"]);
    fs.unlinkSync(parent);
    fs.renameSync(`${parent}.held`, parent);
    await manageProtectedOpenShellWorkspace("restore", input);
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
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
      await (operation === "prepare"
        ? undefined
        : manageProtectedOpenShellWorkspace("prepare", input));
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
    const { safeFile: original } = await vi.importActual<
      typeof import("../../../tools/e2e/protected-openshell-filesystem.mts")
    >("../../../tools/e2e/protected-openshell-filesystem.mts");
    vi.mocked(protectedFs.safeFile).mockImplementationOnce((root, file) => {
      expect(join(root, file)).toBe(path);
      fs.renameSync(path, retained);
      fs.symlinkSync(retained, path);
      return original(root, file);
    });
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(/Unsafe/);
    expect(fs.readlinkSync(path)).toBe(retained);
    expect(fs.statSync(retained)).toMatchObject({
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
  });

  it("rejects a hard-linked destination without changing its contents", async () => {
    const input = fixture();
    const path = join(input.trustedRoot, "scripts/install-openshell.sh");
    fs.linkSync(path, `${path}.retained`);
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(/Unsafe/);
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
    expect(fs.statSync(path).nlink).toBe(2);
  });

  it("rolls back an incomplete prepare when a later replacement fails", async () => {
    const input = fixture();
    const { replaceSource: original } = await vi.importActual<
      typeof import("../../../tools/e2e/protected-openshell-filesystem.mts")
    >("../../../tools/e2e/protected-openshell-filesystem.mts");
    vi.mocked(protectedFs.replaceSource)
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw new Error("fixture replacement failure");
      });
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
      /fixture replacement failure/,
    );
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it("runs workflow recovery after preparation and its rollback both fail", async () => {
    const input = fixture();
    const { replaceSource: original } = await vi.importActual<
      typeof import("../../../tools/e2e/protected-openshell-filesystem.mts")
    >("../../../tools/e2e/protected-openshell-filesystem.mts");
    const failProjection = vi.fn(() => {
      throw new Error("fixture projection failure");
    });
    const failRollback = vi.fn(() => {
      throw new Error("fixture rollback failure");
    });
    vi.mocked(protectedFs.replaceSource)
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockImplementationOnce(failProjection)
      .mockImplementationOnce(failRollback);
    await expect(manageProtectedOpenShellWorkspace("prepare", input)).rejects.toThrow(
      /fixture rollback failure/,
    );
    expect(failProjection).toHaveBeenCalledOnce();
    expect(failRollback).toHaveBeenCalledOnce();
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).not.toBe("");
    const result = executeWorkflowRestoration(input, "failure");
    expect(result.condition).toBe("${{ always() }}");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      operation: "restore",
      workflowSha: input.workflowSha,
      candidateSha: input.candidateSha,
    });
    expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it.each(["failure", "cancelled", "skipped"])(
    "skips recovery without a receipt when preparation was %s",
    (outcome) => {
      const input = fixture();
      const result = executeWorkflowRestoration(input, outcome);
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("");
      expect(git(input.trustedRoot, "status", "--porcelain")).toBe("");
    },
  );

  it.each<[string, string, (receiptPath: string) => void]>([
    ["missing", "success", (receiptPath) => fs.unlinkSync(receiptPath)],
    ["malformed", "failure", (receiptPath) => fs.writeFileSync(receiptPath, "{")],
    [
      "dangling symlink",
      "failure",
      (receiptPath) => {
        fs.unlinkSync(receiptPath);
        fs.symlinkSync(`${receiptPath}.missing`, receiptPath);
      },
    ],
  ])("fails workflow recovery for a %s receipt after %s", async (_kind, outcome, mutate) => {
    const input = fixture();
    await manageProtectedOpenShellWorkspace("prepare", input);
    mutate(join(input.trustedRoot, ".git/nemoclaw-openshell-projection.json"));
    const before = git(input.trustedRoot, "diff", "--no-ext-diff");
    const result = executeWorkflowRestoration(input, outcome);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /Unsafe protected OpenShell file|Invalid protected OpenShell recovery/,
    );
    expect(git(input.trustedRoot, "diff", "--no-ext-diff")).toBe(before);
  });
});

describe("protected admitted SDK preparation", () => {
  it("restores the trusted SDK after revoked admission without the candidate checkout or API token", async () => {
    const f = admittedSdkFixture();
    await manageProtectedOpenShellWorkspace("prepare", f.input);
    f.sdk.records.splice(0);
    await expect(manageProtectedOpenShellWorkspace("verify", f.input)).rejects.toThrow(
      /approval|decision/i,
    );
    f.request.mockClear();
    fs.rmSync(f.input.candidateRoot, { recursive: true });
    const restored = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../tools/e2e/protected-openshell-workspace.mts", import.meta.url),
        ),
        "restore",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: f.input.trustedRoot,
          NEMOCLAW_E2E_TESTED_ROOT: f.input.candidateRoot,
          CHECKOUT_SHA: f.input.candidateSha,
          NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA: f.input.workflowSha,
        },
      },
    );
    expect(JSON.parse(restored)).toMatchObject({
      operation: "restore",
      workflowSha: f.input.workflowSha,
    });
    await manageProtectedOpenShellWorkspace("restore", { ...f.input, admission: undefined });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.stage).not.toHaveBeenCalled();
    expect(git(f.input.trustedRoot, "status", "--porcelain")).toBe("");
  });
  it("stages admitted bytes while retaining trusted scripts, dependencies and restore behavior", async () => {
    const f = admittedSdkFixture();
    const original = f.manifest();
    await manageProtectedOpenShellWorkspace("prepare", f.input);
    await prepareProtectedOpenShellSdk(f.preparation, f.input, f.stage);
    expect(f.stage).toHaveBeenCalledExactlyOnceWith({
      archive: f.sdk.bytes,
      artifactName: f.selected.artifactName,
      cacheDirectory: f.preparation.cacheDirectory,
    });
    const actual = f.manifest();
    expect(actual).toEqual({
      ...original,
      optionalDependencies: {
        ...original.optionalDependencies,
        "@nvidia/openshell-sdk": f.selected.packageSpec.split("@").at(-1),
      },
    });
    await manageProtectedOpenShellWorkspace("restore", f.input);
    expect(git(f.input.trustedRoot, "status", "--porcelain")).toBe("");
  });

  it.each<[string, RegExp]>([
    ["missing-approval", /PR approval covering/],
    ["tampered-archive", /integrity/],
    ["projection-drift", /Unexpected verify source: package.json/],
    ["plugin-drift", /Unrelated changes in the trusted controller/],
    ["wrong-target", /artifact preparation in the trusted controller/],
    ["registry-mode", /artifact preparation in the trusted controller/],
    ["admitted-source-drift", /Committed candidate SDK differs from the approved commit/],
  ])("rejects %s before staging", async (kind, expected) => {
    const f = admittedSdkFixture();
    await manageProtectedOpenShellWorkspace("prepare", f.input);
    f.mutate(kind);
    await expect(prepareProtectedOpenShellSdk(f.preparation, f.input, f.stage)).rejects.toThrow(
      expected,
    );
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects approval revocation after archive verification before staging", async () => {
    const f = admittedSdkFixture();
    await manageProtectedOpenShellWorkspace("prepare", f.input);
    await expect(
      prepareProtectedOpenShellSdk(
        f.preparation,
        { ...f.input, admission: { ...f.input.admission, request: f.revokingRequest() } },
        f.stage,
      ),
    ).rejects.toThrow(/approval|decision/i);
    expect(f.stage).not.toHaveBeenCalled();
  });
});
