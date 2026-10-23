// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  collectPiQualification,
  piQualificationPatch,
} from "../../../tools/managed-images/collect-pi-qualification.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const SHA = "a".repeat(40);
const REPOSITORY = "NVIDIA/NemoClaw";
const AUTHORITY = "src/lib/agent/candidate-authority.ts";
const receiptPath = (arch: string) => `ci/pi-agent-qualification-v1-linux-${arch}.json`;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const pr = {
    number: 12,
    state: "open",
    head: { sha: SHA, repo: { full_name: REPOSITORY } },
    base: { repo: { full_name: REPOSITORY } },
  };
  const run = {
    id: 20,
    run_attempt: 1,
    workflow_id: 30,
    name: "Images / Build, Test, and Publish Managed Images",
    path: ".github/workflows/managed-images.yaml",
    event: "pull_request",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    pull_requests: [{ number: 12 }],
  };
  const contracts = ["amd64", "arm64"].map((arch, index) => {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    return {
      contractVersion: 1,
      agent: "pi",
      platform: `linux/${arch}`,
      image: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
      digest,
      reference: `ghcr.io/nvidia/nemoclaw/pi-sandbox@${digest}`,
      source: { repository: REPOSITORY, revision: SHA, cohort: "ghrun-20-1", release: "v0.1.0" },
      startupProfileContractVersion: 1,
      capabilityContractVersion: 1,
    };
  });
  const archives = () =>
    contracts.map((contract) =>
      artifactZip([{ name: "contract.json", contents: `${JSON.stringify(contract, null, 2)}\n` }]),
    );
  const responses = new Map<string, () => unknown>([
    [`/repos/${REPOSITORY}/pulls/12`, () => structuredClone(pr)],
    [
      `/repos/${REPOSITORY}/actions/workflows/managed-images.yaml`,
      () => ({ id: 30, path: run.path, state: "active" }),
    ],
    [`/repos/${REPOSITORY}/actions/runs/20`, () => structuredClone(run)],
  ]);
  ["amd64", "arm64"].forEach((arch, index) => {
    responses.set(
      `/repos/${REPOSITORY}/actions/runs/20/artifacts?name=managed-candidate-contract-20-1-pi-${arch}&per_page=100`,
      () => {
        const archive = archives()[index]!;
        return {
          total_count: 1,
          artifacts: [
            {
              id: index + 40,
              name: `managed-candidate-contract-20-1-pi-${arch}`,
              expired: false,
              size_in_bytes: archive.length,
              digest: `sha256:${hash(archive)}`,
              archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${index + 40}/zip`,
              workflow_run: { id: 20, head_sha: run.head_sha },
            },
          ],
        };
      },
    );
  });
  const request = vi.fn(async (apiPath: string): Promise<unknown> => responses.get(apiPath)!());
  const download = vi.fn(async (identity: { id: number }) => archives()[identity.id - 40]!);
  const collect = () =>
    collectPiQualification({ candidateSha: SHA, prNumber: 12, runId: 20 }, request, download);
  return { pr, run, contracts, request, download, collect, responses };
}

type Fixture = ReturnType<typeof fixture>;

describe("Pi qualification collection", () => {
  it("preserves authenticated receipt bytes and calculates both authority hashes", async () => {
    const input = fixture();
    const result = await input.collect();
    expect(result.digests).toEqual(
      ["amd64", "arm64"].map((arch) => hash(result.receipts[receiptPath(arch)]!)),
    );
    expect(JSON.parse(result.receipts[receiptPath("arm64")]!)).toEqual(input.contracts[1]);
    expect(input.request.mock.calls.filter(([url]) => url.endsWith("/pulls/12"))).toHaveLength(2);
    expect(input.download).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "failure", "cancelled", "skipped"])(
    "rejects %s publication before downloading receipts",
    async (conclusion) => {
      const input = fixture();
      input.run.conclusion = conclusion;
      await expect(input.collect()).rejects.toThrow("must complete successfully");
      expect(input.download).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "fork",
      (input: Fixture) => {
        input.pr.head.repo.full_name = "someone/NemoClaw";
      },
    ],
    [
      "closed",
      (input: Fixture) => {
        input.pr.state = "closed";
      },
    ],
    [
      "stale",
      (input: Fixture) => {
        input.pr.head.sha = "b".repeat(40);
      },
    ],
  ] as const)("rejects a %s PR", async (_state, mutate) => {
    const input = fixture();
    mutate(input);
    await expect(input.collect()).rejects.toThrow("current open upstream PR commit");
    expect(input.download).not.toHaveBeenCalled();
  });

  it.each([
    [
      "revision",
      (input: Fixture) => {
        input.contracts[1]!.source.revision = "b".repeat(40);
      },
    ],
    [
      "cohort",
      (input: Fixture) => {
        input.contracts[1]!.source.cohort = "ghrun-20-2";
      },
    ],
    [
      "release",
      (input: Fixture) => {
        input.contracts[1]!.source.release = "v0.2.0";
      },
    ],
    [
      "platform",
      (input: Fixture) => {
        input.contracts[1]!.platform = "linux/amd64";
      },
    ],
  ] as const)("rejects a mismatched ARM64 %s", async (_field, mutate) => {
    const input = fixture();
    mutate(input);
    await expect(input.collect()).rejects.toThrow();
  });

  it("rejects substituted archive bytes", async () => {
    const input = fixture();
    input.download.mockResolvedValue(Buffer.from("substituted"));
    await expect(input.collect()).rejects.toThrow("authenticated identity");
  });

  it.each([
    ["missing", { total_count: 0, artifacts: [] }],
    ["duplicate", { total_count: 2, artifacts: [{ name: "irrelevant" }, { name: "irrelevant" }] }],
    [
      "expired",
      {
        total_count: 1,
        artifacts: [{ name: "managed-candidate-contract-20-1-pi-amd64", expired: true }],
      },
    ],
    [
      "wrong-commit",
      {
        total_count: 1,
        artifacts: [
          {
            name: "managed-candidate-contract-20-1-pi-amd64",
            workflow_run: { id: 20, head_sha: "b".repeat(40) },
          },
        ],
      },
    ],
  ])("rejects %s artifact metadata", async (_kind, overrides) => {
    const input = fixture();
    const url = `/repos/${REPOSITORY}/actions/runs/20/artifacts?name=managed-candidate-contract-20-1-pi-amd64&per_page=100`;
    const listing = (await input.request(url)) as {
      total_count: number;
      artifacts: Record<string, unknown>[];
    };
    input.responses.set(url, () => ({
      ...overrides,
      artifacts: overrides.artifacts.map((artifact) => ({ ...listing.artifacts[0], ...artifact })),
    }));
    await expect(input.collect()).rejects.toThrow();
    expect(input.download).not.toHaveBeenCalled();
  });

  it.each([
    [
      "workflow",
      (input: Fixture) => {
        input.run.workflow_id = 31;
      },
    ],
    [
      "event",
      (input: Fixture) => {
        input.run.event = "workflow_dispatch";
      },
    ],
    [
      "PR",
      (input: Fixture) => {
        input.run.pull_requests[0]!.number = 13;
      },
    ],
  ] as const)("rejects publication from another %s", async (_kind, mutate) => {
    const input = fixture();
    mutate(input);
    await expect(input.collect()).rejects.toThrow();
    expect(input.download).not.toHaveBeenCalled();
  });

  it.each([
    [
      "PR",
      (input: Fixture) => {
        input.pr.head.sha = "b".repeat(40);
      },
      "current open upstream PR commit",
    ],
    [
      "attempt",
      (input: Fixture) => {
        input.run.run_attempt = 2;
      },
      "attempt changed",
    ],
  ] as const)(
    "rejects a changed %s after artifact acquisition",
    async (_changed, mutate, message) => {
      const input = fixture();
      const original = input.download.getMockImplementation()!;
      input.download.mockImplementationOnce(original).mockImplementationOnce(async (identity) => {
        const bytes = await original(identity);
        mutate(input);
        return bytes;
      });
      await expect(input.collect()).rejects.toThrow(message);
    },
  );

  it("generates a three-file patch that Git applies without changing other authority", async () => {
    const collected = await fixture().collect();
    const originals = {
      [receiptPath("amd64")]: "{}\n",
      [receiptPath("arm64")]: "{}",
      [AUTHORITY]: `export const authority = {\n  pi: Object.freeze([\n    "${"c".repeat(64)}",\n    "${"d".repeat(64)}",\n  ]),\n  untouched: true,\n};\n`,
    };
    const patch = piQualificationPatch(collected, originals);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qualification-patch-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      Object.entries(originals).forEach(([file, contents]) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), contents);
      });
      execFileSync("git", ["apply", "--check", "-"], { cwd: root, input: patch });
      execFileSync("git", ["apply", "-"], { cwd: root, input: patch });
      expect(
        Object.fromEntries(
          Object.keys(collected.receipts).map((file) => [
            file,
            fs.readFileSync(path.join(root, file), "utf8"),
          ]),
        ),
      ).toEqual(collected.receipts);
      const evaluated = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const { authority } = await import(process.argv[1]); console.log(JSON.stringify(authority));",
          pathToFileURL(path.join(root, AUTHORITY)).href,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(evaluated)).toEqual({ pi: collected.digests, untouched: true });
      expect(patch.match(/^diff --git /gmu)).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unrecognized authority layout without producing a partial patch", async () => {
    const collected = await fixture().collect();
    expect(() => piQualificationPatch(collected, { [AUTHORITY]: "export const pi = [];" })).toThrow(
      "two-receipt declaration",
    );
  });

  it("prints a CLI patch without mutating the checkout or passing the API token to Git", async () => {
    const input = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qualification-cli-"));
    const originalPath = process.env.PATH ?? "";
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    try {
      git("init", "-q");
      const originals = {
        [receiptPath("amd64")]: "{}\n",
        [receiptPath("arm64")]: "{}\n",
        [AUTHORITY]: `const authority = { pi: Object.freeze(["${"c".repeat(64)}", "${"d".repeat(64)}"]) };\n`,
      };
      Object.entries(originals).forEach(([file, contents]) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), contents);
      });
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
      const sha = git("rev-parse", "HEAD").trim();
      input.pr.head.sha = sha;
      input.run.head_sha = sha;
      input.contracts.forEach((contract) => {
        contract.source.revision = sha;
      });
      const responseEntries = await Promise.all(
        [
          "pulls/12",
          "actions/workflows/managed-images.yaml",
          "actions/runs/20",
          ...["amd64", "arm64"].map(
            (arch) =>
              `actions/runs/20/artifacts?name=managed-candidate-contract-20-1-pi-${arch}&per_page=100`,
          ),
        ].map(async (suffix) => {
          const apiPath = `/repos/${REPOSITORY}/${suffix}`;
          const json = await input.request(apiPath);
          return [`https://api.github.com${apiPath}`, { json }];
        }),
      );
      const archiveEntries = await Promise.all(
        [40, 41].map(async (id) => [
          `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}/zip`,
          { bytes: (await input.download({ id })).toString("base64") },
        ]),
      );
      const responses = Object.fromEntries([...responseEntries, ...archiveEntries]);
      const hook = `const responses = ${JSON.stringify(responses)};
        globalThis.fetch = async (url, init) => {
          if (init.headers.Authorization !== "Bearer test-token") throw new Error("missing API token");
          const value = responses[String(url)];
          if (!value) throw new Error("unexpected network request");
          return new Response(value.bytes ? Buffer.from(value.bytes, "base64") : JSON.stringify(value.json));
        };`;
      const shim = path.join(root, ".git", "token-free-bin");
      fs.mkdirSync(shim);
      fs.writeFileSync(
        path.join(shim, "git"),
        '#!/bin/sh\n[ -z "${GITHUB_TOKEN+x}" ] || exit 87\n' +
          `PATH='${originalPath.replaceAll("'", "'\\''")}' exec git "$@"\n`,
        { mode: 0o700 },
      );
      const patch = execFileSync(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(hook)}`,
          fileURLToPath(
            new URL("../../../tools/managed-images/collect-pi-qualification.mts", import.meta.url),
          ),
          "12",
          "20",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { PATH: `${shim}:${originalPath}`, GITHUB_TOKEN: "test-token" },
        },
      );
      expect(git("status", "--porcelain")).toBe("");
      expect(patch).not.toContain("test-token");
      expect(patch.match(/^diff --git /gmu)).toHaveLength(3);
      execFileSync("git", ["apply", "--check", "-"], { cwd: root, input: patch });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
