// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateOpenShellVersion } from "../../tools/e2e/candidate-openshell-version.mts";
import { CANDIDATE_OPENSHELL_SOURCES } from "../../tools/e2e/candidate-openshell-trust.mts";
import { validateInstallerSources } from "../../scripts/checks/extract-installer-pins.mts";
import { fixture, identity } from "../helpers/candidate-openshell-trust";

export async function runCandidateOpenShellCli(options: {
  upgradeVersion?: string;
  approved?: boolean;
}) {
  const currentFiles = Object.fromEntries(
    Object.values(CANDIDATE_OPENSHELL_SOURCES).map((path) => [
      path,
      readFileSync(new URL(`../../${path}`, import.meta.url)),
    ]),
  );
  const currentSources = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      key,
      currentFiles[path]!.toString("utf8"),
    ]),
  ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
  const currentVersion = validateInstallerSources(currentSources).releaseVersion;
  // An already selected release needs no synthetic registry entry or fresh approval.
  const candidate =
    options.upgradeVersion && options.upgradeVersion !== currentVersion
      ? fixture(options.upgradeVersion)
      : undefined;
  const responses: Record<string, unknown> = {};
  const selected = await candidateOpenShellVersion(
    "NVIDIA/NemoClaw",
    identity.candidateSha,
    async (url) => {
      let response: unknown;
      if (candidate) {
        response = await candidate.request(url);
      } else {
        const path = new URL(url, "https://api.github.com").pathname.replace(
          "/repos/NVIDIA/NemoClaw/contents/",
          "",
        );
        const source = currentFiles[path];
        if (!source) throw new Error(`Unexpected candidate source: ${path}`);
        response = {
          type: "file",
          path,
          encoding: "base64",
          size: source.length,
          content: source.toString("base64"),
        };
      }
      responses[url] = response;
      return response;
    },
    candidate ? identity : undefined,
  );
  if (options.approved === false) {
    responses["/repos/NVIDIA/NemoClaw/pulls/123/reviews?per_page=100&page=1"] = [];
  }

  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-mcp-cli-"));
  try {
    const output = join(directory, "github-output");
    const preload = `const responses = ${JSON.stringify(responses)};
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        const key = url.pathname + url.search;
        if (url.origin !== "https://api.github.com" || !Object.hasOwn(responses, key))
          throw new Error("Unexpected offline fixture request: " + input);
        return new Response(JSON.stringify(responses[key]), {
          status: 200, headers: { "content-type": "application/json" }
        });
      };`;
    // Keep fixture bytes out of Linux's per-argument size limit.
    const preloadPath = join(directory, "offline-fetch.mjs");
    writeFileSync(preloadPath, preload, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preloadPath).href,
        new URL("../../tools/e2e/candidate-openshell-version.mts", import.meta.url).pathname,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          GITHUB_OUTPUT: output,
          GITHUB_TOKEN: "offline-fixture",
          CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
          CANDIDATE_SHA: identity.candidateSha,
          MCP_RUNTIME_REQUIRED: "true",
          ...(candidate
            ? {
                UPGRADE_PR_NUMBER: String(identity.prNumber),
                UPGRADE_BASE_SHA: identity.baseSha,
              }
            : {}),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const outputExists = existsSync(output);
    const emitted: Record<string, string> = outputExists
      ? Object.fromEntries(
          readFileSync(output, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        )
      : {};
    return {
      selected,
      status: result.status,
      stderr: result.stderr,
      diagnostic: result.error?.message ?? result.signal ?? result.stderr,
      outputExists,
      emitted,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
