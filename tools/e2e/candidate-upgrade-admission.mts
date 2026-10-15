// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Authenticate permission to test candidate artifacts; never grants merge or host-code authority. */
export interface CandidateUpgradeIdentity {
  prNumber: number;
  candidateSha: string;
  baseSha: string;
}

export type UpgradeRequest = (path: string) => Promise<unknown>;
type RecordValue = Record<string, unknown>;
const REPOSITORY = "NVIDIA/NemoClaw";
const PREFIX = `/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/u;
const LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/u;
const MAX_PAGES = 100;
const MAX_SOURCE_BYTES = 1024 * 1024;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Upgrade admission received an invalid GitHub record");
  }
  return value as RecordValue;
}

function assertIdentity(identity: CandidateUpgradeIdentity): void {
  if (
    !Number.isSafeInteger(identity.prNumber) ||
    identity.prNumber < 1 ||
    !SHA.test(identity.candidateSha) ||
    !SHA.test(identity.baseSha)
  )
    throw new Error("Upgrade admission requires a PR number and immutable candidate/base commits");
}

function assertPullRequest(
  value: unknown,
  identity: CandidateUpgradeIdentity,
  mergeSha?: string,
): string {
  const pr = record(value);
  const head = record(pr.head);
  const base = record(pr.base);
  const author = record(pr.user);
  if (mergeSha !== undefined && pr.merge_commit_sha !== mergeSha)
    throw new Error("Upgrade admission no longer matches the GitHub merge commit");
  if (
    pr.number !== identity.prNumber ||
    pr.state !== "open" ||
    head.sha !== identity.candidateSha ||
    base.sha !== identity.baseSha ||
    base.ref !== "main" ||
    record(head.repo).full_name !== REPOSITORY ||
    record(base.repo).full_name !== REPOSITORY ||
    typeof author.login !== "string" ||
    !LOGIN.test(author.login)
  )
    throw new Error("Upgrade admission no longer matches the open upstream PR");
  return author.login.toLowerCase();
}

async function comments(request: UpgradeRequest, prNumber: number): Promise<RecordValue[]> {
  const result: RecordValue[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const values = await request(`${PREFIX}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100) {
      throw new Error("Upgrade admission could not read complete PR comments");
    }
    for (const value of values) {
      const entry = record(value);
      if (!Number.isSafeInteger(entry.id) || Number(entry.id) < 1 || seen.has(Number(entry.id))) {
        throw new Error("Upgrade admission received duplicate or invalid comment identities");
      }
      seen.add(Number(entry.id));
      result.push(entry);
    }
    if (values.length < 100) return result;
  }
  throw new Error("Upgrade admission comment pagination exceeded its bound");
}

type Decision = { id: number; login: string; action: "approve" | "revoke" };

async function currentDecision(
  request: UpgradeRequest,
  identity: CandidateUpgradeIdentity,
  author: string,
): Promise<Decision> {
  const candidates: Decision[] = [];
  const permissions = new Map<string, boolean>();
  for (const entry of await comments(request, identity.prNumber)) {
    const match =
      typeof entry.body === "string"
        ? /^NemoClaw-Upgrade-E2E: (approve|revoke) ([a-f0-9]{40}) ([a-f0-9]{40})$/u.exec(entry.body)
        : null;
    if (
      !match ||
      match[0] !== entry.body ||
      match[2] !== identity.candidateSha ||
      match[3] !== identity.baseSha
    )
      continue;
    // Edited records are not authority: moderation can retain the original author's identity.
    if (
      typeof entry.created_at !== "string" ||
      !Number.isFinite(Date.parse(entry.created_at)) ||
      entry.created_at !== entry.updated_at
    )
      continue;
    const user = record(entry.user);
    const login = typeof user.login === "string" ? user.login : "";
    if (user.type !== "User" || !LOGIN.test(login) || login.toLowerCase() === author) continue;
    const key = login.toLowerCase();
    if (!permissions.has(key)) {
      const response = record(await request(`${PREFIX}/collaborators/${login}/permission`));
      // Repository membership or author_association is not a permission check.
      const role = response.role_name;
      permissions.set(key, role === "maintain" || role === "admin");
    }
    if (permissions.get(key)) {
      candidates.push({ id: Number(entry.id), login, action: match[1] as Decision["action"] });
    }
  }
  const latest = candidates.sort((left, right) => right.id - left.id)[0];
  if (!latest || latest.action !== "approve") {
    throw new Error(
      "Candidate upgrade needs an independent maintainer's current commit-bound E2E approval",
    );
  }
  return latest;
}

export async function readCandidateUpgradeSource(
  request: UpgradeRequest,
  sha: string,
  path: string,
): Promise<string> {
  if (!SHA.test(sha)) throw new Error("Candidate source requires an immutable commit");
  if (
    path.includes("\n") ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid candidate upgrade source path");
  }
  const blob = record(await request(`${PREFIX}/contents/${path}?ref=${sha}`));
  if (
    blob.type !== "file" ||
    blob.path !== path ||
    blob.encoding !== "base64" ||
    !Number.isSafeInteger(blob.size) ||
    Number(blob.size) < 1 ||
    Number(blob.size) > MAX_SOURCE_BYTES ||
    typeof blob.content !== "string" ||
    blob.content.length > 1_500_000 ||
    blob.target !== undefined ||
    blob.submodule_git_url !== undefined
  )
    throw new Error(`Invalid candidate upgrade source: ${path}`);
  const bytes = Buffer.from(blob.content, "base64");
  const value = bytes.toString("utf8");
  if (bytes.length !== blob.size || bytes.includes(0) || !Buffer.from(value).equals(bytes)) {
    throw new Error(`Invalid candidate upgrade source bytes: ${path}`);
  }
  return value;
}

/**
 * Read inert inputs between two live admission checks. No caller-supplied receipt, candidate
 * workflow, cached role, or local manifest can substitute for the independent GitHub decision.
 * Call again before a later privileged phase; the returned data is not reusable authorization.
 */
export async function readApprovedCandidateUpgrade(
  input: CandidateUpgradeIdentity,
  paths: readonly string[],
  request: UpgradeRequest,
  mergeSha?: string,
): Promise<{ sources: Readonly<Record<string, string>>; reviewer: string; commentId: number }> {
  const identity = Object.freeze({ ...input });
  const selection = [...paths];
  assertIdentity(identity);
  if (mergeSha !== undefined && !SHA.test(mergeSha))
    throw new Error("Upgrade admission requires an immutable merge commit");
  if (
    selection.length === 0 ||
    selection.length > 32 ||
    new Set(selection).size !== selection.length
  ) {
    throw new Error("Upgrade admission requires a bounded, unique source selection");
  }
  const prPath = `${PREFIX}/pulls/${identity.prNumber}`;
  const author = assertPullRequest(await request(prPath), identity, mergeSha);
  const before = await currentDecision(request, identity, author);
  if (mergeSha !== undefined) {
    const merge = record(await request(`${PREFIX}/git/commits/${mergeSha}`));
    if (
      merge.sha !== mergeSha ||
      !Array.isArray(merge.parents) ||
      merge.parents.length !== 2 ||
      record(merge.parents[0]).sha !== identity.baseSha ||
      record(merge.parents[1]).sha !== identity.candidateSha
    )
      throw new Error(
        "Upgrade admission merge parents differ from the approved base and candidate; synchronize the PR and refresh its commit-bound approval",
      );
  }
  const sources: Record<string, string> = Object.create(null);
  for (const path of selection)
    sources[path] = await readCandidateUpgradeSource(
      request,
      mergeSha ?? identity.candidateSha,
      path,
    );
  if (assertPullRequest(await request(prPath), identity, mergeSha) !== author) {
    throw new Error("Upgrade admission PR author changed during source acquisition");
  }
  const after = await currentDecision(request, identity, author);
  if (before.id !== after.id || before.login !== after.login) {
    throw new Error("Upgrade admission decision changed during source acquisition");
  }
  return { sources: Object.freeze(sources), reviewer: after.login, commentId: after.id };
}
