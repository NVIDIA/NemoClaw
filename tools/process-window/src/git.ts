// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { excluded, type Branch } from "./model.js";

export function sourceLines(content: string): string[] {
  return content === "" ? [] : content.replace(/\n$/, "").split("\n");
}

export class Repository {
  private trees = new Map<string, string[]>();
  private contents = new Map<string, string>();
  constructor(
    readonly path: string,
    readonly excludePaths: string[] = [],
  ) {
    this.git(["rev-parse", "--git-dir"]);
  }
  git(args: string[], maxBuffer = 32 * 1024 * 1024): string {
    return execFileSync("git", ["-C", this.path, ...args], {
      encoding: "utf8",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  revision(ref: string): string {
    return this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  }
  files(rev: string): string[] {
    if (!this.trees.has(rev))
      this.trees.set(
        rev,
        this.git(["ls-tree", "-rz", "--name-only", rev])
          .split("\0")
          .filter(
            (p) =>
              p &&
              !excluded(p) &&
              !this.excludePaths.some(
                (prefix) =>
                  p === prefix.replace(/\/$/, "") || p.startsWith(`${prefix.replace(/\/$/, "")}/`),
              ),
          ),
      );
    return this.trees.get(rev)!;
  }
  read(rev: string, path: string): string {
    if (excluded(path) || !this.files(rev).includes(path))
      throw Error("Path not in the allowed revision tree");
    const key = `${rev}:${path}`;
    if (this.contents.has(key)) return this.contents.get(key)!;
    const content = this.git(["show", key], 4 * 1024 * 1024);
    if (content.includes("\0")) throw Error("Binary file");
    this.contents.set(key, content);
    return content;
  }
  search(rev: string, text: string, contains = "", offset = 0) {
    const hits: { path: string; matches: { line: number; text: string }[] }[] = [];
    for (const path of this.files(rev).filter((p) =>
      p.toLowerCase().includes(contains.toLowerCase()),
    )) {
      try {
        const matches = sourceLines(this.read(rev, path))
          .flatMap((line, i) =>
            line.toLowerCase().includes(text.toLowerCase())
              ? [{ line: i + 1, text: line.slice(0, 500) }]
              : [],
          )
          .slice(0, 8);
        if (matches.length) hits.push({ path, matches });
      } catch {
        /* Binary or oversized files cannot provide text guidance. */
      }
    }
    return {
      hits: hits.slice(offset, offset + 100),
      total: hits.length,
      nextOffset: offset + 100 < hits.length ? offset + 100 : null,
    };
  }
  diff(old: string | undefined, rev: string): string {
    if (!old)
      return "No incremental revision is available. Reconcile the full repository with the existing mapping, if any.";
    try {
      return this.git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        old,
        rev,
        "--",
        ".",
        ":(exclude)**/acceptance-references/**",
        ":(exclude)acceptance-references/**",
        ":(exclude)**/node_modules/**",
        ...this.excludePaths.map((p) => `:(exclude,literal)${p.replace(/\/$/, "")}`),
      ]).slice(0, 80000);
    } catch {
      return "Previous revision unavailable. Reconcile the full repository with the existing mapping.";
    }
  }
  validateSources(branch: Branch): void {
    const files = new Set(this.files(branch.revision));
    for (const mechanism of branch.mechanisms ?? [])
      for (const usage of mechanism.usages) {
        for (const requirement of usage.requirements ?? []) {
          const count = sourceLines(this.read(branch.revision, requirement.source.path)).length;
          if ((requirement.source.end ?? requirement.source.start) > count)
            throw Error(`Requirement evidence outside file: ${mechanism.id}`);
        }
        if (usage.lifecycle) {
          const source = usage.lifecycle.source;
          const count = sourceLines(this.read(branch.revision, source.path)).length;
          if ((source.end && source.end < source.start) || (source.end ?? source.start) > count)
            throw Error(`Lifecycle evidence outside file: ${mechanism.id}`);
        }
        if (!usage.source) continue;
        const count = sourceLines(this.read(branch.revision, usage.source.path)).length;
        if ((usage.source.end ?? usage.source.start) > count)
          throw Error(`Usage source line outside file: ${mechanism.id}`);
      }
    for (const input of branch.inputs) {
      if (input.unavailable) continue;
      if (!files.has(input.source.path)) throw Error(`Missing source: ${input.source.path}`);
      const count = sourceLines(this.read(branch.revision, input.source.path)).length;
      if ((input.source.end ?? input.source.start) > count)
        throw Error(`Source line outside file: ${input.id}`);
    }
  }
}
