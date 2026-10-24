// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, rename, rm, mkdir, open, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { parse, stringify } from "yaml";
import {
  configSchema,
  reconcile,
  reassessBranch,
  validateMapping,
  type Config,
  type Mapping,
} from "./model.js";
import { Repository } from "./git.js";
import { infer } from "./inference.js";
import { render } from "./build.js";
import { pathToFileURL } from "node:url";

async function optionalRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
export async function run(
  command: string,
  configPath: string,
  branchIds: string[] = [],
): Promise<void> {
  if (!["analyze", "assess", "reassess", "build"].includes(command))
    throw Error("Use analyze, assess, reassess, or build");
  const configFile = resolve(configPath);
  const config: Config = configSchema.parse(parse(await readFile(configFile, "utf8")));
  const root = dirname(configFile);
  const mappingPath = resolve(root, config.mapping);
  const output = resolve(root, config.output);
  const repository = resolve(root, config.repository.path);
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  // A generated directory is replaceable; never permit it to swallow source/configuration.
  if (
    [configFile, mappingPath, repository, resolve(".")].some((p) => inside(output, p)) ||
    inside(repository, output) ||
    inside(repository, mappingPath)
  )
    throw Error(
      "Mapping/output must be outside the analyzed repository; output must not contain source or configuration",
    );
  await mkdir(dirname(mappingPath), { recursive: true });
  const lockPath = `${mappingPath}.lock`;
  const lock = await open(lockPath, "wx").catch(() => {
    throw Error(
      `Another run may own ${lockPath}; remove a stale lock only after verifying no run is active`,
    );
  });
  const staged = `${output}.staging-${process.pid}`;
  const backup = `${output}.backup-${process.pid}`;
  const temporaryMapping = `${mappingPath}.${process.pid}.tmp`;
  try {
    const original = await optionalRead(mappingPath);
    const repo = new Repository(repository, config.excludePaths);
    let mapping: Mapping = original
      ? validateMapping(parse(original), config)
      : { version: 1, repository: config.repository.url, branches: [] };
    if (command !== "build") {
      for (const id of branchIds)
        if (!config.branches.some((b) => b.id === id)) throw Error(`Unknown branch ${id}`);
      let committed: string | undefined;
      try {
        const home = new Repository(dirname(mappingPath));
        const top = home.git(["rev-parse", "--show-toplevel"]).trim();
        committed = home.git([
          "show",
          `HEAD:${relative(await realpath(top), await realpath(mappingPath))}`,
        ]);
      } catch {
        /* No committed baseline yet. */
      }
      for (const branch of config.branches.filter(
        (b) => !branchIds.length || branchIds.includes(b.id),
      )) {
        const revision = repo.revision(branch.ref);
        console.log(
          `${command === "assess" ? "Assessing requirements for" : command === "reassess" ? "Reassessing" : "Analyzing"} ${branch.name} at ${revision}`,
        );
        const previous = mapping.branches.find((b) => b.id === branch.id);
        if (
          (command === "assess" || command === "reassess") &&
          (!previous || previous.revision !== revision || !previous.mechanisms?.length)
        )
          throw Error(
            "Assessment requires an existing mechanism inventory at the configured revision; run analyze first",
          );
        const proposal = await infer(
          config,
          repo,
          branch.id,
          revision,
          previous,
          committed,
          command === "assess" ? "assess" : command === "reassess" ? "reassess" : "analyze",
        );
        // Validate the raw proposal too; reconciliation must not mask invalid output.
        validateMapping({ ...mapping, branches: [proposal] }, config);
        repo.validateSources(proposal);
        const next =
          command === "reassess"
            ? reassessBranch(previous!, proposal)
            : reconcile(previous, proposal);
        const paths = new Set(repo.files(revision));
        for (const input of next.inputs)
          if (!paths.has(input.source.path)) {
            input.unavailable = true;
            input.note =
              `${input.note ?? ""}\nUnresolved: source no longer exists at this revision.`.trim();
          }
        validateMapping({ ...mapping, branches: [next] }, config);
        repo.validateSources(next);
        mapping = {
          ...mapping,
          branches: [...mapping.branches.filter((b) => b.id !== branch.id), next],
        };
      }
    } else if (!original) throw Error("No mapping exists; run analysis first");
    mapping = validateMapping(mapping, config);
    for (const branch of mapping.branches) repo.validateSources(branch);
    await render(config, mapping, staged);
    if ((await optionalRead(mappingPath)) !== original)
      throw Error("Mapping changed during analysis; refusing to overwrite concurrent edits");
    let savedOutput = false;
    let savedMapping = false;
    try {
      try {
        await rename(output, backup);
        savedOutput = true;
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (command !== "build") {
        await writeFile(temporaryMapping, stringify(mapping, { lineWidth: 100 }));
        await rename(temporaryMapping, mappingPath);
        savedMapping = true;
      }
      await rename(staged, output);
    } catch (error) {
      if (savedMapping) {
        if (original === undefined) await rm(mappingPath, { force: true });
        else {
          await writeFile(temporaryMapping, original);
          await rename(temporaryMapping, mappingPath);
        }
      }
      if (savedOutput) await rename(backup, output);
      throw error;
    }
    if (savedOutput) await rm(backup, { recursive: true, force: true });
    console.log(`Mapping: ${mappingPath}\nBrowser: ${output}/index.html`);
  } finally {
    await rm(staged, { recursive: true, force: true });
    await rm(temporaryMapping, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, configPath, ...branches] = process.argv.slice(2);
  if (!command || !configPath) {
    console.error(
      "Usage: npx tsx src/entry.ts <analyze|assess|reassess|build> <config.yaml> [branch-id ...]",
    );
    process.exitCode = 1;
  } else
    run(command, configPath, branches).catch((error) => {
      // No raw provider payloads, subprocess stderr, or environment values in diagnostics.
      console.error(
        error instanceof Error && !("stderr" in error)
          ? error.message
          : "Repository inspection failed; check path and revision availability",
      );
      process.exitCode = 1;
    });
}
