// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { configSchema, type Config } from "./model.js";
import { Repository } from "./git.js";

function matchesTag(selector: string, requested: string) {
  const pattern = new RegExp(
    `^${selector
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return requested.startsWith("refs/tags/") && pattern.test(requested.slice("refs/tags/".length));
}

export function selectRevision(
  config: Config,
  repo: Repository,
  branchId: string,
  requested = "",
  release = false,
) {
  const branch = config.branches.find((b) => b.id === branchId);
  if (!branch) throw Error("Unconfigured branch");
  const branchRevision = repo.revision(branch.ref);
  if (release) {
    const selector = branch.refresh.tags;
    if (branch.refresh.mode !== "release" || !selector || !requested.startsWith("refs/tags/"))
      throw Error("Invalid release selection");
    if (!matchesTag(selector, requested))
      throw Error("Release tag does not match configured selector");
  }
  const revision = requested ? repo.revision(requested) : branchRevision;
  // A tag matching a name pattern can belong to an unrelated branch.
  if (release) repo.git(["merge-base", "--is-ancestor", revision, branchRevision]);
  return revision;
}

export async function prepareRun(
  configPath: string,
  source: string,
  state: string,
  output: string,
  branchId: string,
  requested = "",
  mode = "analyze",
  baselinePath?: string,
) {
  if (!["analyze", "branch", "release", "build"].includes(mode)) throw Error("Invalid CI mode");
  const config = configSchema.parse(parse(await readFile(configPath, "utf8")));
  config.repository.path = resolve(source);
  config.mapping = resolve(state, "mapping.yaml");
  config.output = resolve(output, "site");
  const selectedBranch = config.branches.find((branch) => branch.id === branchId);
  if (mode !== "build" && !selectedBranch) throw Error("Unconfigured branch");
  const selected =
    mode === "branch"
      ? selectedBranch!.refresh.mode === "branch"
      : mode === "release"
        ? selectedBranch!.refresh.mode === "release" &&
          !!selectedBranch!.refresh.tags &&
          matchesTag(selectedBranch!.refresh.tags, requested)
        : true;
  // An event outside the configured policy must neither invoke inference nor publish.
  if (!selected) return { config, revision: undefined, selected };
  const repo = new Repository(config.repository.path, config.excludePaths);
  const revision =
    mode === "build"
      ? undefined
      : selectRevision(config, repo, branchId, requested, mode === "release");
  if (revision) {
    const branch = config.branches.find((b) => b.id === branchId)!;
    branch.ref = revision;
    branch.diffBase = null;
    if (baselinePath) {
      try {
        const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
        const mapping = parse(await readFile(config.mapping, "utf8"));
        const mapped = mapping.branches?.find((b: { id: string }) => b.id === branchId);
        // Artifact-only successes do not advance the editable mapping. Using
        // their newer revision would omit changes the mapping has never seen.
        if (
          baseline.branch === branchId &&
          mapped?.revision === baseline.revision &&
          /^[a-f0-9]{40,64}$/.test(baseline.revision)
        )
          branch.diffBase = baseline.revision;
      } catch {
        /* Missing or expired CI artifact: reconcile the full repository. */
      }
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "config.yaml"), stringify(config));
  await writeFile(
    join(output, "revision.json"),
    JSON.stringify({ branch: branchId, revision, mode }, null, 2) + "\n",
  );
  return { config, revision, selected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [
    command,
    config,
    source,
    state,
    output,
    branch,
    revision = "",
    mode = "analyze",
    baseline,
  ] = process.argv.slice(2);
  if (command !== "prepare" || !config || !source || !state || !output || !branch)
    throw Error("Usage: ci.ts prepare CONFIG SOURCE STATE OUTPUT BRANCH [REVISION] [MODE]");
  const result = await prepareRun(config, source, state, output, branch, revision, mode, baseline);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `selected=${result.selected}\n`);
  if (!result.selected) console.log("Refresh skipped by configured branch policy.");
}
