// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { candidateOpenShellVersion } from "../../../tools/e2e/candidate-openshell-version.mts";

const sha = "a".repeat(40);
const repository = "NVIDIA/NemoClaw";
function sourceResponse(url: string) {
  const parsed = new URL(url, "https://api.github.com");
  expect(parsed.searchParams.get("ref")).toBe(sha);
  const path = parsed.pathname.replace(`/repos/${repository}/contents/`, "");
  const source = readFileSync(new URL(`../../../${path}`, import.meta.url));
  return {
    type: "file",
    path,
    encoding: "base64",
    size: source.length,
    content: source.toString("base64"),
  };
}

describe("candidate OpenShell selection", () => {
  it("reads only immutable candidate data and selects the reviewed runtime", async () => {
    const request = vi.fn(async (url: string) => sourceResponse(url));
    await expect(candidateOpenShellVersion(repository, sha, request)).resolves.toBe("0.0.116");
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each(["main", "a".repeat(39), `${sha}\nversion=9.9.9`])(
    "rejects mutable or malformed revision %s",
    async (revision) => {
      const request = vi.fn();
      await expect(candidateOpenShellVersion(repository, revision, request)).rejects.toThrow(
        "exact",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects a fork before reading it", async () => {
    const request = vi.fn();
    await expect(candidateOpenShellVersion("other/NemoClaw", sha, request)).rejects.toThrow(
      "exact",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { type: "symlink" },
    { size: 1024 * 1024 + 1 },
    { encoding: "none" },
    { path: "other" },
    { content: "AA==" },
    { size: 0 },
  ])("rejects invalid candidate files %j", async (mutation) => {
    await expect(
      candidateOpenShellVersion(repository, sha, async (url) => ({
        ...sourceResponse(url),
        ...mutation,
      })),
    ).rejects.toThrow("Invalid candidate");
  });

  it("propagates API failure without falling back to main", async () => {
    await expect(
      candidateOpenShellVersion(repository, sha, async () => {
        throw new Error("API denied");
      }),
    ).rejects.toThrow("API denied");
  });

  it.each([
    {
      name: "unknown release",
      target: /.*/,
      rewrite: (source: string) => source.replaceAll("0.0.116", "9.9.9"),
    },
    {
      name: "mismatched blueprint",
      target: /blueprint\.yaml$/,
      rewrite: (source: string) =>
        source.replace(/max_openshell_version: .*/, 'max_openshell_version: "9.9.9"'),
    },
    {
      name: "modified installer",
      target: /install-openshell\.sh$/,
      rewrite: (source: string) => `${source}\nprintf "unreviewed command"\n`,
    },
  ])("rejects $name through the trusted verifier", async ({ target, rewrite }) => {
    await expect(
      candidateOpenShellVersion(repository, sha, async (url) => {
        const blob = sourceResponse(url);
        const original = Buffer.from(blob.content, "base64").toString("utf8");
        const source = target.test(blob.path) ? rewrite(original) : original;
        return {
          ...blob,
          size: Buffer.byteLength(source),
          content: Buffer.from(source).toString("base64"),
        };
      }),
    ).rejects.toThrow();
  });
});
