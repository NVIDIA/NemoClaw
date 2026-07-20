// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retire a released version label after carrying open work forward.
 *
 * Creates the next target label if needed, moves all open PRs and issues,
 * verifies the released label has no open items, then deletes it.
 * Run only inside the release-latest-tag workflow, which serializes this
 * operation with every authorized release-label assignment.
 *
 * Usage: node --experimental-strip-types --no-warnings scripts/retire-release-label.mts <released-version> [--repo OWNER/REPO]
 */

import { execFileSync } from "node:child_process";

interface MovedItem {
  number: number;
  title: string;
  type: "pr" | "issue";
}

interface RetireOutput {
  from: string;
  to: string;
  moved: MovedItem[];
  retired: boolean;
}

function main(): void {
  const args = process.argv.slice(2);
  const from = args[0];
  if (!from) {
    console.error("Usage: retire-release-label.mts <released-version> [--repo OWNER/REPO]");
    process.exit(1);
  }
  validateVersion(from, "released version");
  const to = nextPatch(from);

  const repo = parseRepository(args);

  const moved: MovedItem[] = [];
  if (!releaseLabelExists(repo, from)) {
    const output: RetireOutput = { from, to, moved, retired: true };
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (remoteReleaseTagExists(repo, to)) {
    throw new Error(`Refusing to use release target ${to}; the remote tag already exists`);
  }
  ensureReleaseLabel(repo, to);

  // Move open PRs
  const prs = listOpenItems(repo, "pr", from);
  for (const pr of prs) {
    gh([
      "pr",
      "edit",
      String(pr.number),
      "--repo",
      repo,
      "--remove-label",
      from,
      "--add-label",
      to,
    ]);
    moved.push({ number: pr.number, title: pr.title, type: "pr" });
  }

  // Move open issues
  const issues = listOpenItems(repo, "issue", from);
  for (const issue of issues) {
    gh([
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      repo,
      "--remove-label",
      from,
      "--add-label",
      to,
    ]);
    moved.push({ number: issue.number, title: issue.title, type: "issue" });
  }

  const remaining = [
    ...listOpenItems(repo, "pr", from).map((item) => `PR #${item.number}`),
    ...listOpenItems(repo, "issue", from).map((item) => `issue #${item.number}`),
  ];
  if (remaining.length > 0) {
    throw new Error(
      `Refusing to delete ${from}; open items still carry it: ${remaining.join(", ")}`,
    );
  }

  gh(["label", "delete", from, "--repo", repo, "--yes"]);
  if (releaseLabelExists(repo, from)) {
    throw new Error(`Released label ${from} still exists after deletion`);
  }

  const output: RetireOutput = { from, to, moved, retired: true };
  console.log(JSON.stringify(output, null, 2));
}

function validateVersion(value: string, description: string): void {
  if (!/^v\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid ${description}: ${value}`);
  }
}

function nextPatch(version: string): string {
  const parts = version.slice(1).split(".").map(Number);
  if (!parts.every((part) => Number.isSafeInteger(part))) {
    throw new Error(`Release version exceeds the supported numeric range: ${version}`);
  }
  const [major, minor, patch] = parts;
  if (patch === Number.MAX_SAFE_INTEGER) {
    throw new Error(`Cannot increment release version ${version} safely`);
  }
  return `v${major}.${minor}.${patch + 1}`;
}

function parseRepository(args: string[]): string {
  const index = args.indexOf("--repo");
  if (index === -1) return "NVIDIA/NemoClaw";
  const repo = args[index + 1];
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid --repo value: ${repo ?? ""}`);
  }
  return repo;
}

function listOpenItems(
  repo: string,
  kind: "pr" | "issue",
  label: string,
): Array<{ number: number; title: string }> {
  return ghJsonArray<{ number: number; title: string }>([
    kind,
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,title",
    "--limit",
    "1000",
  ]);
}

function ensureReleaseLabel(repo: string, label: string): void {
  if (releaseLabelExists(repo, label)) return;

  gh([
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--description",
    "Release target",
    "--color",
    "1d76db",
  ]);
}

function releaseLabelExists(repo: string, label: string): boolean {
  const labels = ghJsonArray<{ name: string }>(
    ["label", "list", "--repo", repo, "--search", label, "--json", "name", "--limit", "100"],
    { emptyOutputIsEmptyArray: true },
  );
  return labels.some((entry) => entry.name === label);
}

function remoteReleaseTagExists(repo: string, tag: string): boolean {
  const refs = ghJsonArray<{ ref: string }>(["api", `repos/${repo}/git/matching-refs/tags/${tag}`]);
  return refs.some((entry) => entry.ref === `refs/tags/${tag}`);
}

function ghJsonArray<T>(
  args: string[],
  { emptyOutputIsEmptyArray = false }: { emptyOutputIsEmptyArray?: boolean } = {},
): T[] {
  const output = gh(args);
  if (output === "" && emptyOutputIsEmptyArray) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`expected JSON array, got ${typeof parsed}`);
    }
    return parsed as T[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse gh JSON output for gh ${args.join(" ")}: ${reason}`);
  }
}

function gh(args: string[]): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const errorObject = typeof error === "object" && error !== null ? error : null;
    const stdout = readStringProperty(errorObject, "stdout")?.trim();
    const stderr = readStringProperty(errorObject, "stderr")?.trim();
    throw new Error([`gh ${args.join(" ")} failed`, stdout, stderr].filter(Boolean).join("\n"));
  }
}

function readStringProperty(value: object | null, key: string): string | undefined {
  if (!value || Array.isArray(value)) return undefined;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

main();
