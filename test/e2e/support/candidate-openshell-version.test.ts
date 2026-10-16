// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import * as installerPins from "../../../scripts/checks/extract-installer-pins.mts";
import {
  candidateOpenShellVersion,
  reviewedOpenShellMcpRuntime,
} from "../../../tools/e2e/candidate-openshell-version.mts";

const sha = "a".repeat(40);
const repository = "NVIDIA/NemoClaw";
const blueprint = readFileSync(
  new URL("../../../nemoclaw-blueprint/blueprint.yaml", import.meta.url),
  "utf8",
);
const blueprintVersions = [...blueprint.matchAll(/^max_openshell_version: "(\d+\.\d+\.\d+)"$/gm)];
assert.equal(blueprintVersions.length, 1, "Expected one blueprint OpenShell pin");
const pinnedVersion = blueprintVersions[0]![1]!;
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
    await expect(candidateOpenShellVersion(repository, sha, request)).resolves.toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("returns the trusted verifier's selection without substituting a workflow pin", async () => {
    const verifier = vi.spyOn(installerPins, "validateInstallerSources").mockReturnValueOnce({
      releaseVersion: "9.8.7",
      pins: [],
      installerReleases: [],
      installerTemplateSha256: "",
      brevTemplateSha256: "",
    });
    try {
      await expect(
        candidateOpenShellVersion(repository, sha, async (url) => {
          const blob = sourceResponse(url);
          const source = `fixture ${blob.path}`;
          return { ...blob, content: Buffer.from(source).toString("base64"), size: source.length };
        }),
      ).resolves.toBe("9.8.7");
      expect(verifier).toHaveBeenCalledExactlyOnceWith({
        blueprintSource: "fixture nemoclaw-blueprint/blueprint.yaml",
        installerSource: "fixture scripts/install-openshell.sh",
        brevInstallerSource: "fixture scripts/brev-launchable-ci-cpu.sh",
        supervisorRuntimeSource: "fixture src/lib/onboard/docker-driver-gateway-runtime.ts",
      });
    } finally {
      verifier.mockRestore();
    }
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
      rewrite: (source: string) => source.replaceAll(pinnedVersion, "9.9.9"),
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

describe("reviewed candidate MCP runtime evidence", () => {
  it.each([
    ["0.0.116", "mcp-bridge", "mcp-bridge-deepagents"],
    ["0.0.116", "openshell-credential-generation-window", "openshell-credential-generation-window"],
    ["0.1.3", "mcp-bridge", "mcp-bridge-deepagents"],
    ["0.1.3", "openshell-credential-generation-window", "openshell-credential-generation-window"],
  ])("passes %s provenance unchanged through the %s installer", (version, job, artifact) => {
    const runtime = reviewedOpenShellMcpRuntime(version);
    const workflow = YAML.parse(readFileSync(".github/workflows/e2e.yaml", "utf8"));
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-mcp-provenance-"));
    try {
      mkdirSync(join(directory, "scripts"));
      writeFileSync(join(directory, "scripts/install-openshell.sh"), "exit 0\n");
      const step = workflow.jobs[job].steps.find(
        (step: { name: string }) => step.name === "Install OpenShell CLI",
      );
      const result = spawnSync("bash", ["-c", step.run], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          E2E_ARTIFACT_DIR: directory,
          NEMOCLAW_MCP_BRIDGE_AGENT: "deepagents",
          OPENSHELL_RUNTIME_PROVENANCE: JSON.stringify(runtime.provenance),
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const saved = JSON.parse(
        readFileSync(join(directory, artifact, "openshell-exact-main-provenance.json"), "utf8"),
      );
      expect(saved).toEqual(runtime.provenance);
      expect(saved.releaseTag).toBe(`v${version}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["9.9.9", "0.1.3\nsupervisor_image=unreviewed", "", "__proto__"])(
    "rejects runtime evidence without a reviewed release: %j",
    (version) => {
      expect(() => reviewedOpenShellMcpRuntime(version)).toThrow(
        "no reviewed MCP runtime provenance",
      );
    },
  );
});
