// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PullRequestReader } from "../scripts/checks/openshell-qualification-paths.mts";
import {
  classifyPullRequestGate,
  createGitHubReader,
  type GateInputs,
  readBlueprintVersion,
  readBoundedJsonResponse,
  runCli,
  verifyDraftPullRequestGate,
} from "../scripts/checks/verify-openshell-qualification-pr-gate.mts";

const REPOSITORY = "NVIDIA/NemoClaw" as const;
const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const INPUTS: GateInputs = {
  baseSha: BASE_SHA,
  candidateSha: CANDIDATE_SHA,
  prNumber: 42,
  repository: REPOSITORY,
};
const tempRoots: string[] = [];

type GateReader = PullRequestReader & {
  getPullRequest(repository: string, prNumber: number): Promise<unknown>;
};

function pullRequest(
  candidateRepository: string = REPOSITORY,
  candidateSha = CANDIDATE_SHA,
  state = "open",
  baseRef = "main",
) {
  return {
    base: { ref: baseRef, repo: { full_name: REPOSITORY }, sha: BASE_SHA },
    head: { repo: { full_name: candidateRepository }, sha: candidateSha },
    number: 42,
    state,
  };
}

function reader(
  files: unknown[],
  candidateRepository: string = REPOSITORY,
  candidateSha = CANDIDATE_SHA,
  state = "open",
  baseRef = "main",
): GateReader {
  return {
    getPullRequest: async () => pullRequest(candidateRepository, candidateSha, state, baseRef),
    getPullRequestFilesPage: async (_repository, _prNumber, page) => (page === 1 ? files : []),
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-pr-gate-"));
  tempRoots.push(root);
  return root;
}

function writeDraftRoot(root: string, contract: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "ci"), { recursive: true });
  fs.mkdirSync(path.join(root, "nemoclaw-blueprint"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "ci/openshell-0.0.101-qualification-v1.json"),
    JSON.stringify(contract),
  );
  fs.writeFileSync(
    path.join(root, "nemoclaw-blueprint/blueprint.yaml"),
    fs.readFileSync("nemoclaw-blueprint/blueprint.yaml"),
  );
}

function draftContract(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync("ci/openshell-0.0.101-qualification-v1.json", "utf8"),
  ) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenShell base-trusted draft PR gate", () => {
  it("classifies the live exact pull request and fails sensitive forks closed (#8590)", async () => {
    const files = [{ filename: "scripts/install-openshell.sh", status: "modified" }];

    await expect(classifyPullRequestGate(INPUTS, reader(files))).resolves.toEqual({
      required: true,
      sameRepository: true,
      sensitivePaths: ["scripts/install-openshell.sh"],
    });
    await expect(
      classifyPullRequestGate(INPUTS, reader(files, "attacker/fork")),
    ).resolves.toMatchObject({ required: true, sameRepository: false });
  });

  it("rejects a live pull request whose exact head changed (#8590)", async () => {
    await expect(
      classifyPullRequestGate(
        INPUTS,
        reader([{ filename: "docs/index.mdx", status: "modified" }], REPOSITORY, "c".repeat(40)),
      ),
    ).rejects.toThrow("does not match the workflow event");
  });

  it.each([
    ["closed", "main", "not open"],
    ["open", "release", "no longer targets main"],
  ])("rejects a %s pull request targeting %s (#8590)", async (state, baseRef, message) => {
    await expect(
      classifyPullRequestGate(
        INPUTS,
        reader(
          [{ filename: "scripts/install-openshell.sh", status: "modified" }],
          REPOSITORY,
          CANDIDATE_SHA,
          state,
          baseRef,
        ),
      ),
    ).rejects.toThrow(message);
  });

  it("rejects closure or retargeting between live identity reads (#8590)", async () => {
    const identities = [pullRequest(), pullRequest(REPOSITORY, CANDIDATE_SHA, "closed", "main")];
    const api: GateReader = {
      getPullRequest: async () => identities.shift(),
      getPullRequestFilesPage: async () => [
        { filename: "scripts/install-openshell.sh", status: "modified" },
      ],
    };

    await expect(classifyPullRequestGate(INPUTS, api)).rejects.toThrow("not open");
  });

  it("accepts the later multi-file candidate through draft data only (#8590)", async () => {
    const baseRoot = tempRoot();
    const candidateRoot = tempRoot();
    const base = draftContract();
    const candidate = draftContract();
    candidate.requiredWorkflowGate = {
      organizationRulesetId: 8642,
      repositoryId: 1182547092,
      sourcePath: ".github/workflows/openshell-0.0.101-pr-gate.yaml",
      sourceRef: "refs/heads/main",
    };
    writeDraftRoot(baseRoot, base);
    writeDraftRoot(candidateRoot, candidate);
    const files = [
      { filename: ".github/workflows/openshell-0.0.101-qualification.yaml", status: "added" },
      { filename: "scripts/checks/openshell-qualification-contract.mts", status: "added" },
      { filename: "scripts/checks/openshell-qualification-github.mts", status: "added" },
      { filename: "src/lib/adapters/container-engine.ts", status: "modified" },
    ];

    await expect(
      verifyDraftPullRequestGate({ ...INPUTS, baseRoot, candidateRoot }, reader(files)),
    ).resolves.toBeUndefined();
  });

  it("rejects candidate receipt state and OpenShell version movement (#8590)", async () => {
    const baseRoot = tempRoot();
    const candidateRoot = tempRoot();
    const base = draftContract();
    const candidate = draftContract();
    candidate.artifacts = [{ name: "qualification receipt" }];
    writeDraftRoot(baseRoot, base);
    writeDraftRoot(candidateRoot, candidate);
    const sensitive = reader([{ filename: "scripts/install-openshell.sh", status: "modified" }]);

    await expect(
      verifyDraftPullRequestGate({ ...INPUTS, baseRoot, candidateRoot }, sensitive),
    ).rejects.toThrow("artifacts is invalid for draft bootstrap");

    writeDraftRoot(candidateRoot, draftContract());
    fs.writeFileSync(
      path.join(candidateRoot, "nemoclaw-blueprint/blueprint.yaml"),
      'min_openshell_version: "0.0.101"\nmax_openshell_version: "0.0.101"\n',
    );
    await expect(
      verifyDraftPullRequestGate({ ...INPUTS, baseRoot, candidateRoot }, sensitive),
    ).rejects.toThrow("must remain byte-identical to the trusted base");

    fs.writeFileSync(
      path.join(candidateRoot, "nemoclaw-blueprint/blueprint.yaml"),
      'min_openshell_version: "0.0.99"\nmax_openshell_version: "0.0.99"\nmin_openshell_version: 0.0.101\n',
    );
    await expect(
      verifyDraftPullRequestGate({ ...INPUTS, baseRoot, candidateRoot }, sensitive),
    ).rejects.toThrow("must remain byte-identical to the trusted base");
  });

  it("rejects linked and oversized OpenShell version blueprints (#8590)", () => {
    const root = tempRoot();
    const blueprintDirectory = path.join(root, "nemoclaw-blueprint");
    const blueprintPath = path.join(blueprintDirectory, "blueprint.yaml");
    const targetPath = path.join(root, "target.yaml");
    const source = fs.readFileSync("nemoclaw-blueprint/blueprint.yaml");
    fs.mkdirSync(blueprintDirectory, { recursive: true });
    fs.writeFileSync(blueprintPath, source);
    expect(readBlueprintVersion(root)).toBe("0.0.99");
    fs.renameSync(blueprintPath, targetPath);
    fs.symlinkSync(targetPath, blueprintPath);
    expect(() => readBlueprintVersion(root)).toThrow("regular non-link file");
    fs.unlinkSync(blueprintPath);
    fs.writeFileSync(blueprintPath, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readBlueprintVersion(root)).toThrow("bounded regular non-link file");
  });

  it("rejects an intermediate candidate blueprint directory link (#8590)", async () => {
    const baseRoot = tempRoot();
    const candidateRoot = tempRoot();
    writeDraftRoot(baseRoot, draftContract());
    writeDraftRoot(candidateRoot, draftContract());
    fs.rmSync(path.join(candidateRoot, "nemoclaw-blueprint"), { recursive: true });
    fs.symlinkSync(
      path.join(baseRoot, "nemoclaw-blueprint"),
      path.join(candidateRoot, "nemoclaw-blueprint"),
    );

    await expect(
      verifyDraftPullRequestGate(
        { ...INPUTS, baseRoot, candidateRoot },
        reader([{ filename: "scripts/install-openshell.sh", status: "modified" }]),
      ),
    ).rejects.toThrow("path crosses a symbolic link");
  });

  it("bounds streamed GitHub JSON before parsing it (#8590)", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), "GitHub test", 64),
    ).resolves.toEqual({ ok: true });
    await expect(
      readBoundedJsonResponse(
        new Response(new Uint8Array(65), { headers: { "content-length": "65" } }),
        "GitHub test",
        64,
      ),
    ).rejects.toThrow("oversized");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    });
    await expect(readBoundedJsonResponse(new Response(body), "GitHub test", 64)).rejects.toThrow(
      "oversized",
    );
  });

  it("uses fixed GitHub endpoints with timeout and redirect rejection (#8590)", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(pullRequest())))
      .mockResolvedValueOnce(new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    const api = createGitHubReader("token");

    await api.getPullRequest(REPOSITORY, 42);
    await api.getPullRequestFilesPage(REPOSITORY, 42, 1);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/NVIDIA/NemoClaw/pulls/42",
      expect.objectContaining({ redirect: "error", signal: timeoutSignal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/NVIDIA/NemoClaw/pulls/42/files?per_page=100&page=1",
      expect.objectContaining({ redirect: "error", signal: timeoutSignal }),
    );
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each([
    "verify",
    "authority",
    "produce",
    "create-receipt",
  ])("does not expose candidate receipt or authority command %s (#8590)", async (command) => {
    await expect(runCli([command], { GITHUB_TOKEN: "token" })).rejects.toThrow(
      "must be classify or verify-draft",
    );
  });
});
