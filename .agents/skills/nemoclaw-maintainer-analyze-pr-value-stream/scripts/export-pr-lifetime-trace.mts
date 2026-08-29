// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

type ValidatedEvent = {
  name?: unknown;
  ph?: unknown;
  ts?: unknown;
  dur?: unknown;
  pid?: unknown;
  tid?: unknown;
  args?: unknown;
};

export async function validateChromeTrace(
  file: string,
): Promise<{ events: number; tracks: number }> {
  const payload = JSON.parse(await readFile(file, "utf8")) as { traceEvents?: unknown };
  if (!Array.isArray(payload.traceEvents)) throw new Error("traceEvents must be an array");
  const tracks = new Map<string, { ts: number; dur: number; name: string }[]>();
  const metadata = new Set<string>();
  for (const raw of payload.traceEvents as ValidatedEvent[]) {
    if (typeof raw.name !== "string" || !["C", "M", "i", "X"].includes(String(raw.ph)))
      throw new Error("trace event used an unsupported Chrome trace phase");
    if (!Number.isSafeInteger(raw.pid) || !Number.isSafeInteger(raw.tid))
      throw new Error("trace event pid and tid must be safe integers");
    if (raw.ph === "M") {
      const key = raw.name + ":" + raw.pid + ":" + raw.tid;
      if (metadata.has(key)) throw new Error("duplicate trace metadata event " + key);
      metadata.add(key);
      continue;
    }
    if (!Number.isSafeInteger(raw.ts))
      throw new Error("timed trace event must have a safe timestamp");
    if (raw.ph === "C") {
      if (
        raw.args === null ||
        typeof raw.args !== "object" ||
        Object.values(raw.args).some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
      )
        throw new Error("counter trace event args must be finite numbers");
      continue;
    }
    if (raw.ph !== "X") continue;
    if (!Number.isSafeInteger(raw.dur) || Number(raw.dur) < 0)
      throw new Error("complete trace event must have a nonnegative safe duration");
    const key = raw.pid + ":" + raw.tid;
    const track = tracks.get(key) ?? [];
    track.push({ ts: Number(raw.ts), dur: Number(raw.dur), name: raw.name });
    tracks.set(key, track);
  }
  for (const [key, events] of tracks) {
    events.sort((left, right) => left.ts - right.ts || right.dur - left.dur);
    const stack: typeof events = [];
    for (const event of events) {
      while (stack.length > 0 && event.ts >= stack.at(-1)!.ts + stack.at(-1)!.dur) stack.pop();
      if (stack.length > 0 && event.ts + event.dur > stack.at(-1)!.ts + stack.at(-1)!.dur)
        throw new Error("crossing complete events on trace track " + key);
      stack.push(event);
    }
  }
  return { events: payload.traceEvents.length, tracks: tracks.size };
}

const MAX_PAGES = 10;
const MAX_REVISIONS = 250;
const MAX_WORKFLOW_RUNS = 2_000;
const MAX_JOBS = 10_000;
const MAX_TRACE_EVENTS = 250_000;
const MAX_TRACE_BYTES = 100_000_000;
const PAGE_SIZE = 100;
const READ_CONCURRENCY = 8;
const PUBLICATION_LOCK_STALE_MS = 5 * 60 * 1_000;

type GithubRead = (args: string[]) => Promise<{ stdout: string }>;

type TraceEvent = {
  name: string;
  cat?: string;
  ph: "C" | "M" | "i" | "X";
  ts?: number;
  dur?: number;
  pid: number;
  tid: number;
  s?: "t";
  args: Record<string, string | number | boolean | null>;
};

type Commit = {
  oid: string;
  committedAt: number;
  subject: string;
};

type Run = {
  id: number;
  event: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  status: string;
  conclusion: string | null;
  name: string;
  html_url: string;
};

export type LifetimeArtifacts = {
  directory: string;
  summary: string;
  trace: string;
  traceEvents: number;
  lifecycleEvents: number;
  revisions: number;
  workflowRuns: number;
  jobs: number;
  externalChecks: number;
  manifest: string;
  truncated: false;
  caveats: string[];
};

type ExportInput = {
  workdir: string;
  repository: string;
  number: number;
  report: unknown;
  pullSnapshot: unknown;
  githubRead: GithubRead;
  trackTemporaryPath?: (path: string, cleanup?: () => Promise<void>) => void;
  releaseTemporaryPath?: (path: string) => void;
};

function parseTime(value: unknown, label: string): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(label + " was not a valid timestamp");
  return Date.parse(value);
}

function optionalTime(value: unknown): number | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

function micros(milliseconds: number): number {
  return Math.round(milliseconds * 1_000);
}

function boundedText(value: unknown, maximum = 300): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function validateArray(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(label + " response was not an array");
  return value;
}

async function readPages(input: {
  githubRead: GithubRead;
  endpoint: string;
  projection: string;
  label: string;
}): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = input.endpoint.includes("?") ? "&" : "?";
    const result = await input.githubRead([
      "api",
      input.endpoint + separator + "per_page=" + PAGE_SIZE + "&page=" + page,
      "--jq",
      input.projection,
    ]);
    const pageRows = validateArray(JSON.parse(result.stdout), input.label);
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function mapBounded<T, R>(values: T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < values.length; index += READ_CONCURRENCY) {
    result.push(
      ...(await Promise.all(values.slice(index, index + READ_CONCURRENCY).map(operation))),
    );
  }
  return result;
}

type MetadataIndex = { processes: Set<number>; threads: Set<string> };

function addMetadata(
  events: TraceEvent[],
  index: MetadataIndex,
  pid: number,
  tid: number,
  processName: string,
  threadName: string,
): void {
  if (!index.processes.has(pid)) {
    index.processes.add(pid);
    events.push({ name: "process_name", ph: "M", pid, tid: 0, args: { name: processName } });
  }
  const threadKey = pid + ":" + tid;
  if (!index.threads.has(threadKey)) {
    index.threads.add(threadKey);
    events.push({ name: "thread_name", ph: "M", pid, tid, args: { name: threadName } });
  }
}

function addInstant(
  events: TraceEvent[],
  input: {
    name: string;
    category: string;
    at: number;
    pid: number;
    tid: number;
    args?: TraceEvent["args"];
  },
): void {
  events.push({
    name: input.name,
    cat: input.category,
    ph: "i",
    s: "t",
    ts: micros(input.at),
    pid: input.pid,
    tid: input.tid,
    args: input.args ?? {},
  });
}

function addCounter(
  events: TraceEvent[],
  name: string,
  at: number,
  value: number,
  pid: number,
  tid: number,
): void {
  events.push({ name, cat: "pr.counter", ph: "C", ts: micros(at), pid, tid, args: { value } });
}

function addSpan(
  events: TraceEvent[],
  input: {
    name: string;
    category: string;
    start: number | null;
    end: number | null;
    pid: number;
    tid: number;
    args?: TraceEvent["args"];
  },
): void {
  if (input.start === null) return;
  if (input.end === null || input.end < input.start) {
    addInstant(events, {
      name: input.name + " — timing incomplete",
      category: input.category,
      at: input.start,
      pid: input.pid,
      tid: input.tid,
      args: { ...(input.args ?? {}), timingIncomplete: true },
    });
    return;
  }
  events.push({
    name: input.name,
    cat: input.category,
    ph: "X",
    ts: micros(input.start),
    dur: micros(input.end - input.start),
    pid: input.pid,
    tid: input.tid,
    args: input.args ?? {},
  });
}

function validateObjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value))
    throw new Error("pull request commit had an invalid object ID");
  return value;
}

function normalizeCommits(pull: any): Commit[] {
  const rows = validateArray(pull?.commits, "pull request commits");
  if (rows.length < 1 || rows.length > MAX_REVISIONS)
    throw new Error("lifetime trace requires between 1 and " + MAX_REVISIONS + " revisions");
  return rows.map((commit: any) => ({
    oid: validateObjectId(commit?.oid),
    committedAt: parseTime(commit?.committedDate, "commit committedDate"),
    subject:
      boundedText(commit?.messageHeadline, 200) ||
      "Commit " + String(commit?.oid ?? "").slice(0, 8),
  }));
}

async function readPull(input: ExportInput): Promise<any> {
  const result = await input.githubRead([
    "pr",
    "view",
    String(input.number),
    "--repo",
    input.repository,
    "--json",
    "number,url,state,isDraft,createdAt,mergedAt,updatedAt,author,headRefOid,commits,reviews",
  ]);
  const pull = JSON.parse(result.stdout);
  if (pull?.number !== input.number || typeof pull?.url !== "string")
    throw new Error("GitHub pull request response did not match the lifetime trace contract");
  return pull;
}

async function readRuns(
  input: ExportInput,
  commits: Commit[],
): Promise<{ rows: Run[]; truncated: false }> {
  const groups = await mapBounded(commits, async (commit) => {
    const collection = await readPages({
      githubRead: input.githubRead,
      endpoint:
        "repos/" + input.repository + "/actions/runs?head_sha=" + encodeURIComponent(commit.oid),
      projection:
        "[.workflow_runs[] | {id,event,head_sha,created_at,updated_at,status,conclusion,name,html_url}]",
      label: "workflow runs",
    });
    if (collection.truncated)
      throw new Error("workflow history exceeded the bounded lifetime pages for " + commit.oid);
    return collection.rows.filter(
      (run) => run?.head_sha === commit.oid && Number.isSafeInteger(run?.id),
    );
  });
  const rows = [...new Map(groups.flat().map((run) => [run.id, run])).values()];
  if (rows.length > MAX_WORKFLOW_RUNS)
    throw new Error("lifetime workflow history exceeded " + MAX_WORKFLOW_RUNS + " runs");
  return { rows: rows as Run[], truncated: false };
}

async function readJobs(input: ExportInput, runs: Run[]): Promise<any[]> {
  const groups = await mapBounded(runs, async (run) => {
    const result = await input.githubRead([
      "api",
      "repos/" + input.repository + "/actions/runs/" + run.id + "/jobs?filter=all&per_page=100",
      "--jq",
      "{total_count,jobs:[.jobs[] | {id,name,status,conclusion,created_at,started_at,completed_at,runner_name,runner_group_name,html_url,steps}]}",
    ]);
    const payload = JSON.parse(result.stdout);
    const jobs = validateArray(payload?.jobs, "workflow jobs");
    if (Number(payload?.total_count) > jobs.length)
      throw new Error("workflow " + run.id + " exceeded the 100-job lifetime trace bound");
    return jobs.map((job) => ({ ...job, run }));
  });
  const jobs = groups.flat();
  if (jobs.length > MAX_JOBS)
    throw new Error("lifetime workflow history exceeded " + MAX_JOBS + " jobs");
  return jobs;
}

async function readExternalChecks(input: ExportInput, commits: Commit[]): Promise<any[]> {
  const groups = await mapBounded(commits, async (commit) => {
    const collection = await readPages({
      githubRead: input.githubRead,
      endpoint: "repos/" + input.repository + "/commits/" + commit.oid + "/check-runs?filter=all",
      projection:
        "[.check_runs[] | {id,name,status,conclusion,created_at,started_at,completed_at,html_url,app:{id:.app.id,slug:.app.slug}}]",
      label: "check runs",
    });
    if (collection.truncated)
      throw new Error("check runs exceeded the bounded lifetime pages for " + commit.oid);
    return collection.rows
      .filter((check) => check?.app?.slug !== "github-actions")
      .map((check) => ({ ...check, commit }));
  });
  return groups.flat();
}

async function readLifecycle(
  input: ExportInput,
): Promise<{ timeline: any[]; comments: any[]; inline: any[]; truncated: boolean }> {
  const [timeline, comments, inline] = await Promise.all([
    readPages({
      githubRead: input.githubRead,
      endpoint: "repos/" + input.repository + "/issues/" + input.number + "/timeline",
      projection:
        "[.[] | {id,event,created_at,actor:(.actor.login // null),commit_id,label:(.label.name // null),requested_reviewer:(.requested_reviewer.login // null),requested_team:(.requested_team.slug // null),rename}]",
      label: "pull request timeline",
    }),
    readPages({
      githubRead: input.githubRead,
      endpoint: "repos/" + input.repository + "/issues/" + input.number + "/comments",
      projection: "[.[] | {id,created_at,updated_at,user:(.user.login // null),html_url}]",
      label: "pull request comments",
    }),
    readPages({
      githubRead: input.githubRead,
      endpoint: "repos/" + input.repository + "/pulls/" + input.number + "/comments",
      projection:
        "[.[] | {id,created_at,updated_at,user:(.user.login // null),path,line,commit_id,html_url,in_reply_to_id}]",
      label: "pull request review comments",
    }),
  ]);
  return {
    timeline: timeline.rows,
    comments: comments.rows,
    inline: inline.rows,
    truncated: timeline.truncated || comments.truncated || inline.truncated,
  };
}

function renderTrace(input: {
  report: any;
  pull: any;
  commits: Commit[];
  runs: Run[];
  jobs: any[];
  externalChecks: any[];
  lifecycle: Awaited<ReturnType<typeof readLifecycle>>;
}): { events: TraceEvent[]; lifecycleEvents: number } {
  const events: TraceEvent[] = [];
  const metadata: MetadataIndex = { processes: new Set(), threads: new Set() };
  addMetadata(events, metadata, 1, 1, "PR #" + input.pull.number, "Lifecycle");
  addMetadata(events, metadata, 2, 1, "Author activity", input.pull.author?.login ?? "author");
  addMetadata(events, metadata, 3, 1, "Feedback and reviews", "Comments and reviews");
  addMetadata(events, metadata, 4, 1, "PR readiness", "Observed readiness path");
  addMetadata(events, metadata, 5, 1, "PR counters", "Current revision ordinal");
  addMetadata(events, metadata, 5, 2, "PR counters", "Open review requests");
  let lifecycleEvents = 0;
  const instant = (entry: Parameters<typeof addInstant>[1]): void => {
    lifecycleEvents += 1;
    addInstant(events, entry);
  };
  const opened = parseTime(input.pull.createdAt, "pull request createdAt");
  const merged = optionalTime(input.pull.mergedAt);
  const observedEnd = merged ?? optionalTime(input.pull.updatedAt);
  addSpan(events, {
    name: "Pull request lifetime",
    category: "pr.lifecycle",
    start: opened,
    end: observedEnd,
    pid: 1,
    tid: 1,
    args: { state: input.pull.state, url: input.pull.url },
  });
  const revisionObserved = optionalTime(input.report?.events?.latestRevisionObserved?.at);
  const latestRevision = revisionObserved === null ? null : Math.max(opened, revisionObserved);
  const automationSettled = optionalTime(input.report?.events?.automationSettled);
  const approved = optionalTime(input.report?.events?.firstFinalHeadApproval);
  const observedGate =
    automationSettled !== null && approved !== null
      ? Math.max(automationSettled, approved)
      : (automationSettled ?? approved);
  const observedComplete =
    latestRevision === null || observedGate === null
      ? null
      : Math.max(latestRevision, observedGate);
  addSpan(events, {
    name: "Waiting for latest revision",
    category: "pr.readiness",
    start: opened,
    end: latestRevision,
    pid: 4,
    tid: 1,
  });
  addSpan(events, {
    name: "Waiting for observed automation or approval",
    category: "pr.readiness",
    start: latestRevision,
    end: observedComplete,
    pid: 4,
    tid: 1,
    args: {
      automationSettled: input.report?.events?.automationSettled ?? null,
      approvedAt: input.report?.events?.firstFinalHeadApproval ?? null,
    },
  });
  addSpan(events, {
    name: "Observed automation or approval complete",
    category: "pr.readiness",
    start: observedComplete,
    end: merged ?? observedEnd,
    pid: 4,
    tid: 1,
    args: { mergeabilityEstablished: false },
  });
  instant({
    name: "Pull request opened" + (input.pull.isDraft ? " as draft" : " for review"),
    category: "pr.lifecycle",
    at: opened,
    pid: 1,
    tid: 1,
    args: { actor: input.pull.author?.login ?? null, url: input.pull.url, state: input.pull.state },
  });
  for (const row of input.lifecycle.timeline) {
    const at = optionalTime(row?.created_at);
    if (at === null || ["commented", "reviewed", "committed"].includes(String(row?.event)))
      continue;
    instant({
      name: String(row.event).replaceAll("_", " "),
      category: "pr.timeline",
      at,
      pid: 1,
      tid: 1,
      args: {
        actor: row.actor ?? null,
        label: row.label ?? null,
        requestedReviewer: row.requested_reviewer ?? null,
        requestedTeam: row.requested_team ?? null,
        renameFrom: row.rename?.from ?? null,
        renameTo: row.rename?.to ?? null,
      },
    });
  }
  const openRequests = new Map<string, { at: number; id: number | null; tid: number }[]>();
  let nextRequestTrack = 2;
  let requestCount = 0;
  for (const row of input.lifecycle.timeline) {
    const kind = typeof row?.requested_reviewer === "string" ? "user" : "team";
    const reviewer = row?.requested_reviewer ?? row?.requested_team;
    const at = optionalTime(row?.created_at);
    if (typeof reviewer !== "string" || at === null) continue;
    const key = kind + ":" + reviewer;
    const pending = openRequests.get(key) ?? [];
    if (row.event === "review_requested") {
      const request = { at, id: row.id ?? null, tid: nextRequestTrack++ };
      pending.push(request);
      openRequests.set(key, pending);
      requestCount += 1;
      addMetadata(
        events,
        metadata,
        3,
        request.tid,
        "Feedback and reviews",
        "Review request: " + key,
      );
      addCounter(events, "Open review requests", at, requestCount, 5, 2);
      continue;
    }
    if (row.event !== "review_request_removed" || pending.length === 0) continue;
    const request = pending.shift()!;
    if (pending.length === 0) openRequests.delete(key);
    requestCount -= 1;
    addSpan(events, {
      name: "Review requested: " + key,
      category: "review.request",
      start: request.at,
      end: at,
      pid: 3,
      tid: request.tid,
      args: {
        reviewer: key,
        requestEventId: request.id,
        terminalEventId: row.id ?? null,
        terminalState: "removed",
      },
    });
    addCounter(events, "Open review requests", at, requestCount, 5, 2);
  }
  for (const [reviewer, pending] of openRequests)
    for (const request of pending)
      addSpan(events, {
        name: "Review requested: " + reviewer,
        category: "review.request",
        start: request.at,
        end: observedEnd,
        pid: 3,
        tid: request.tid,
        args: { reviewer, requestEventId: request.id, terminalState: "open" },
      });
  for (const review of validateArray(input.pull.reviews ?? [], "pull request reviews")) {
    const submitted = optionalTime(review?.submittedAt);
    if (submitted === null) continue;
    instant({
      name: "Review " + String(review.state ?? "submitted").toLowerCase(),
      category: "review.submission",
      at: submitted,
      pid: 3,
      tid: 1,
      args: { actor: review.author?.login ?? null, commit: review.commit?.oid ?? null },
    });
  }
  for (const row of input.lifecycle.comments) {
    const created = optionalTime(row.created_at);
    if (created !== null)
      instant({
        name: "Comment added",
        category: "review.comment",
        at: created,
        pid: 3,
        tid: 1,
        args: { id: row.id, actor: row.user, url: row.html_url ?? null },
      });
    const updated = optionalTime(row.updated_at);
    if (created !== null && updated !== null && updated !== created)
      instant({
        name: "Comment updated",
        category: "review.comment",
        at: updated,
        pid: 3,
        tid: 1,
        args: { id: row.id, actor: row.user, url: row.html_url ?? null },
      });
  }
  const feedback: { at: number; row: any }[] = [];
  for (const row of input.lifecycle.inline) {
    const created = optionalTime(row.created_at);
    if (created !== null) {
      feedback.push({ at: created, row });
      instant({
        name: "Inline feedback added",
        category: "review.feedback",
        at: created,
        pid: 3,
        tid: 1,
        args: {
          id: row.id,
          actor: row.user,
          path: boundedText(row.path, 500),
          line: row.line ?? null,
          commit: row.commit_id ?? null,
          url: row.html_url ?? null,
        },
      });
    }
    const updated = optionalTime(row.updated_at);
    if (created !== null && updated !== null && updated !== created)
      instant({
        name: "Inline feedback updated",
        category: "review.feedback",
        at: updated,
        pid: 3,
        tid: 1,
        args: { id: row.id, actor: row.user, url: row.html_url ?? null },
      });
  }
  feedback.sort((left, right) => left.at - right.at);
  const firstRuns = new Map<string, Run>();
  for (const run of input.runs
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (!firstRuns.has(run.head_sha)) firstRuns.set(run.head_sha, run);
  }
  const revisionStarts = input.commits.map((commit) => {
    const firstRun = firstRuns.get(commit.oid);
    return firstRun ? parseTime(firstRun.created_at, "workflow createdAt") : commit.committedAt;
  });
  for (const [index, at] of revisionStarts.entries())
    addCounter(events, "Current revision ordinal", at, index + 1, 5, 1);
  for (const [index, commit] of input.commits.entries()) {
    const pid = 1_000 + index;
    addSpan(events, {
      name: "Revision " + (index + 1) + " current",
      category: "pr.revision-epoch",
      start: revisionStarts[index],
      end: revisionStarts[index + 1] ?? observedEnd,
      pid,
      tid: 2,
      args: {
        commit: commit.oid,
        ordinal: index + 1,
        subject: commit.subject,
        current: index === input.commits.length - 1,
        startSource: firstRuns.has(commit.oid)
          ? "first exact-commit workflow"
          : "commit committed timestamp",
      },
    });
    addMetadata(events, metadata, pid, 1, "Revision " + commit.oid.slice(0, 8), "Workflows");
    instant({
      name: commit.subject,
      category: "author.commit",
      at: commit.committedAt,
      pid: 2,
      tid: 1,
      args: { commit: commit.oid },
    });
    const firstRun = firstRuns.get(commit.oid);
    if (firstRun) {
      const pushed = parseTime(firstRun.created_at, "workflow createdAt");
      instant({
        name: "Commit push observed",
        category: "author.push",
        at: pushed,
        pid: 2,
        tid: 1,
        args: { commit: commit.oid, source: "first exact-commit workflow" },
      });
      addSpan(events, {
        name: "Commit publication",
        category: "author.publish",
        start: commit.committedAt,
        end: pushed,
        pid: 2,
        tid: 1_000 + index,
        args: { commit: commit.oid, causality: "not-established" },
      });
      const firstFeedback = feedback.find(
        (entry) => entry.at >= pushed && entry.row.commit_id === commit.oid,
      );
      if (firstFeedback) {
        addSpan(events, {
          name: "Waiting for inline feedback",
          category: "author.waiting-for-feedback",
          start: pushed,
          end: firstFeedback.at,
          pid: 2,
          tid: 2_000 + index,
          args: { commit: commit.oid, feedbackId: firstFeedback.row.id },
        });
      }
    }
  }
  const commitsByAuthoredAt = input.commits
    .slice()
    .sort((left, right) => left.committedAt - right.committedAt);
  for (const [index, entry] of feedback.entries()) {
    const nextCommit = commitsByAuthoredAt.find((commit) => commit.committedAt > entry.at);
    if (!nextCommit) continue;
    addSpan(events, {
      name: "Feedback to next author change",
      category: "author.response",
      start: entry.at,
      end: nextCommit.committedAt,
      pid: 2,
      tid: 3_000 + index,
      args: {
        feedbackId: entry.row.id,
        nextCommit: nextCommit.oid,
        relationship: "next-author-change",
        causality: "not-established",
      },
    });
  }
  for (const [index, run] of input.runs.entries()) {
    const commitIndex = input.commits.findIndex((commit) => commit.oid === run.head_sha);
    const pid = 1_000 + Math.max(0, commitIndex);
    const tid = 10 + index;
    addMetadata(
      events,
      metadata,
      pid,
      tid,
      "Revision " + run.head_sha.slice(0, 8),
      run.name + " #" + run.id,
    );
    addSpan(events, {
      name: run.name,
      category: "ci.workflow",
      start: optionalTime(run.created_at),
      end: optionalTime(run.updated_at),
      pid,
      tid,
      args: {
        runId: run.id,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      },
    });
  }
  for (const [jobIndex, job] of input.jobs.entries()) {
    const commitIndex = input.commits.findIndex((commit) => commit.oid === job.run.head_sha);
    const pid = 1_000 + Math.max(0, commitIndex);
    const tid = 10_000 + jobIndex;
    addMetadata(
      events,
      metadata,
      pid,
      tid,
      "Revision " + job.run.head_sha.slice(0, 8),
      job.run.name + " / " + job.name,
    );
    const created = optionalTime(job.created_at);
    const started = optionalTime(job.started_at);
    const completed = optionalTime(job.completed_at);
    addSpan(events, {
      name: job.name,
      category: "ci.queue",
      start: created,
      end: started,
      pid,
      tid,
      args: {
        jobId: job.id,
        runner: job.runner_name ?? null,
        runnerGroup: job.runner_group_name ?? null,
      },
    });
    addSpan(events, {
      name: job.name,
      category: "ci.execution",
      start: started,
      end: completed,
      pid,
      tid,
      args: {
        jobId: job.id,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url ?? null,
      },
    });
    for (const [stepIndex, step] of validateArray(job.steps ?? [], "workflow steps").entries()) {
      const stepTid = 1_000_000 + jobIndex * 1_000 + stepIndex;
      addMetadata(
        events,
        metadata,
        pid,
        stepTid,
        "Revision " + job.run.head_sha.slice(0, 8),
        job.name + " / " + step.name,
      );
      addSpan(events, {
        name: step.name,
        category: "ci.step",
        start: optionalTime(step.started_at),
        end: optionalTime(step.completed_at),
        pid,
        tid: stepTid,
        args: {
          jobId: job.id,
          number: step.number,
          status: step.status,
          conclusion: step.conclusion,
        },
      });
    }
  }
  for (const [index, check] of input.externalChecks.entries()) {
    const commitIndex = input.commits.findIndex((commit) => commit.oid === check.commit.oid);
    const pid = 1_000 + Math.max(0, commitIndex);
    const tid = 50_000 + index;
    addMetadata(
      events,
      metadata,
      pid,
      tid,
      "Revision " + check.commit.oid.slice(0, 8),
      "External checks",
    );
    addSpan(events, {
      name: check.name,
      category: "ci.external-check",
      start: optionalTime(check.started_at ?? check.created_at),
      end: optionalTime(check.completed_at),
      pid,
      tid,
      args: {
        checkId: check.id,
        app: check.app?.slug ?? null,
        status: check.status,
        conclusion: check.conclusion,
        url: check.html_url ?? null,
      },
    });
  }
  events.sort(
    (a, b) =>
      (a.ts ?? -1) - (b.ts ?? -1) || a.pid - b.pid || a.tid - b.tid || a.name.localeCompare(b.name),
  );
  if (events.length > MAX_TRACE_EVENTS)
    throw new Error("lifetime trace exceeded " + MAX_TRACE_EVENTS + " events");
  return { events, lifecycleEvents };
}

async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const value = await readFile("/proc/" + pid + "/stat", "utf8");
    const fields = value
      .slice(value.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export async function reclaimStalePublicationLock(
  lock: string,
  now = Date.now(),
): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (now - lockStat.mtimeMs <= PUBLICATION_LOCK_STALE_MS) return false;
  let owner: { pid?: unknown; startIdentity?: unknown } | null = null;
  try {
    owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
  } catch {
    // An old lock can be left before owner metadata is written.
  }
  if (owner && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
    const observedIdentity = await processStartIdentity(Number(owner.pid));
    if (observedIdentity !== null && observedIdentity === owner.startIdentity) return false;
    if (observedIdentity === null || owner.startIdentity == null) {
      try {
        process.kill(Number(owner.pid), 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
  }
  const stale = lock + ".stale-" + process.pid + "-" + now;
  try {
    await rename(lock, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await rm(stale, { recursive: true, force: true });
  return true;
}

async function lockOwnershipMatches(lock: string, token: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
    return owner?.token === token;
  } catch {
    return false;
  }
}

async function requirePublicationLockOwnership(lock: string, token: string): Promise<void> {
  if (!(await lockOwnershipMatches(lock, token)))
    throw new Error("lifetime artifact publication lock ownership changed: " + lock);
}

async function reclaimStaleLockCandidates(lock: string): Promise<void> {
  const parent = path.dirname(lock);
  const prefix = path.basename(lock) + ".candidate-";
  let entries: string[] = [];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of entries)
    if (entry.startsWith(prefix)) await reclaimStalePublicationLock(path.join(parent, entry));
}

async function acquirePublicationLock(
  lock: string,
  track?: (path: string, cleanup?: () => Promise<void>) => void,
  release?: (path: string) => void,
): Promise<string> {
  await reclaimStaleLockCandidates(lock);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const token = randomUUID();
    const candidate = lock + ".candidate-" + token;
    await mkdir(candidate);
    track?.(candidate, async () => {
      await rm(candidate, { recursive: true, force: true });
      if (await lockOwnershipMatches(lock, token)) await rm(lock, { recursive: true, force: true });
    });
    try {
      const startIdentity = await processStartIdentity(process.pid);
      await writeFile(
        path.join(candidate, "owner.json"),
        JSON.stringify({
          token,
          pid: process.pid,
          startIdentity,
          createdAt: new Date().toISOString(),
        }) + "\n",
        { mode: 0o600 },
      );
      await rename(candidate, lock);
      track?.(lock, async () => {
        if (await lockOwnershipMatches(lock, token))
          await rm(lock, { recursive: true, force: true });
      });
      release?.(candidate);
      return token;
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      release?.(candidate);
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      if (await reclaimStalePublicationLock(lock)) continue;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("timed out waiting for active lifetime artifact publication lock: " + lock);
}

async function recoverInterruptedPublication(
  destination: string,
  lock: string,
  token: string,
): Promise<void> {
  const parent = path.dirname(destination);
  const prefix = "." + path.basename(destination) + "-staging-";
  const backups = (await readdir(parent))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith("-previous"))
    .map((entry) => path.join(parent, entry));
  let destinationExists = true;
  try {
    await stat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    destinationExists = false;
  }
  if (!destinationExists && backups.length === 1) {
    try {
      await requirePublicationLockOwnership(lock, token);
      await rename(backups[0], destination);
      return;
    } catch (error) {
      throw new Error(
        "failed to restore interrupted lifetime artifact publication from " +
          backups[0] +
          ": " +
          String(error),
      );
    }
  }
  if (!destinationExists && backups.length > 1)
    throw new Error(
      "multiple interrupted lifetime artifact backups require recovery; destination " +
        destination +
        "; for each candidate, verify summary.json and trace.json exist and match the byte sizes in manifest.json; then rename exactly one verified candidate to the destination without deleting the others: " +
        backups.join(", "),
    );
  await requirePublicationLockOwnership(lock, token);
  await Promise.all(backups.map((backup) => rm(backup, { recursive: true, force: true })));
}

export async function publishStagedDirectory(input: {
  staging: string;
  destination: string;
  lock: string;
  validate?: () => Promise<void>;
  track?: (path: string, cleanup?: () => Promise<void>) => void;
  release?: (path: string) => void;
}): Promise<void> {
  const token = await acquirePublicationLock(input.lock, input.track, input.release);
  const heartbeat = setInterval(() => {
    void lockOwnershipMatches(input.lock, token)
      .then((owned) => {
        if (owned) return utimes(input.lock, new Date(), new Date());
        clearInterval(heartbeat);
      })
      .catch(() => undefined);
  }, PUBLICATION_LOCK_STALE_MS / 3);
  const backup = input.staging + "-previous";
  let movedPrevious = false;
  try {
    await recoverInterruptedPublication(input.destination, input.lock, token);
    await input.validate?.();
    await requirePublicationLockOwnership(input.lock, token);
    try {
      await rename(input.destination, backup);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await requirePublicationLockOwnership(input.lock, token);
      await rename(input.staging, input.destination);
    } catch (error) {
      if (movedPrevious) await rename(backup, input.destination);
      throw error;
    }
    if (movedPrevious) {
      await requirePublicationLockOwnership(input.lock, token);
      await rm(backup, { recursive: true, force: true });
    }
  } finally {
    clearInterval(heartbeat);
    if (await lockOwnershipMatches(input.lock, token))
      await rm(input.lock, { recursive: true, force: true });
    input.release?.(input.lock);
  }
}

export async function cleanupLifetimeStaging(
  staging: string,
  original: unknown,
  remove: typeof rm = rm,
): Promise<void> {
  try {
    await remove(staging, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new Error(
      String(original) +
        "; failed to remove retained lifetime staging directory " +
        staging +
        "; remove it manually: " +
        String(cleanupError),
    );
  }
}

export async function exportLifetimeTrace(input: ExportInput): Promise<LifetimeArtifacts> {
  const pull = input.pullSnapshot as any;
  if (pull?.number !== input.number || typeof pull?.url !== "string")
    throw new Error("shared pull request snapshot did not match the lifetime trace contract");
  const expectedHead = (input.report as { headSha?: unknown }).headSha;
  if (typeof expectedHead !== "string" || pull.headRefOid !== expectedHead)
    throw new Error("pull request head changed during lifetime analysis");
  const commits = normalizeCommits(pull);
  const runsCollection = await readRuns(input, commits);
  const [jobs, externalChecks, lifecycle] = await Promise.all([
    readJobs(input, runsCollection.rows),
    readExternalChecks(input, commits),
    readLifecycle(input),
  ]);
  const rendered = renderTrace({
    report: input.report,
    pull,
    commits,
    runs: runsCollection.rows,
    jobs,
    externalChecks,
    lifecycle,
  });
  const caveats = [
    "GitHub does not expose a canonical branch-created timestamp. The first exact-commit workflow is the observable push signal.",
    "GitHub does not expose pull request description edit history. The trace cannot reconstruct description edits.",
    "Feedback-to-change spans identify the next author change. They do not establish causality.",
  ];
  if (lifecycle.truncated)
    throw new Error("pull request lifecycle exceeded the bounded lifetime pages");
  const relativeDirectory = path.join(
    ".nemoclaw-maintainer",
    "pr-value-stream",
    "pr-" + input.number,
  );
  const directory = path.resolve(input.workdir, relativeDirectory);
  const parentDirectory = path.dirname(directory);
  const generatedAt = new Date().toISOString();
  const trace =
    JSON.stringify(
      {
        traceEvents: rendered.events,
        displayTimeUnit: "ms",
        metadata: { repository: input.repository, pullRequest: input.number, generatedAt, caveats },
      },
      null,
      2,
    ) + "\n";
  if (Buffer.byteLength(trace) > MAX_TRACE_BYTES)
    throw new Error("lifetime trace exceeded the 100 MB output bound");
  const artifacts: LifetimeArtifacts = {
    directory: relativeDirectory,
    summary: path.join(relativeDirectory, "summary.json"),
    trace: path.join(relativeDirectory, "trace.json"),
    manifest: path.join(relativeDirectory, "manifest.json"),
    traceEvents: rendered.events.length,
    lifecycleEvents: rendered.lifecycleEvents,
    revisions: commits.length,
    workflowRuns: runsCollection.rows.length,
    jobs: jobs.length,
    externalChecks: externalChecks.length,
    truncated: false,
    caveats,
  };
  const summary =
    JSON.stringify({ ...(input.report as object), lifetime: artifacts }, null, 2) + "\n";
  const manifest =
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: input.repository,
        pullRequest: input.number,
        headSha: pull.headRefOid,
        generatedAt,
        files: { summary: "summary.json", trace: "trace.json" },
        bytes: { summary: Buffer.byteLength(summary), trace: Buffer.byteLength(trace) },
        completeness: {
          revisions: "complete",
          workflowRuns: "complete",
          jobs: "complete",
          checks: "complete",
          lifecycle: "complete",
        },
      },
      null,
      2,
    ) + "\n";
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parentDirectory, ".pr-" + input.number + "-staging-"));
  input.trackTemporaryPath?.(staging);
  const tracePath = path.join(staging, "trace.json");
  const summaryPath = path.join(staging, "summary.json");
  const manifestPath = path.join(staging, "manifest.json");
  try {
    await Promise.all([
      writeFile(tracePath, trace, { mode: 0o600 }),
      writeFile(summaryPath, summary, { mode: 0o600 }),
    ]);
    await validateChromeTrace(tracePath);
    await writeFile(manifestPath, manifest, { mode: 0o600 });
    await publishStagedDirectory({
      staging,
      destination: directory,
      lock: directory + ".lock",
      track: input.trackTemporaryPath,
      release: input.releaseTemporaryPath,
      validate: async () => {
        const currentPull = await readPull(input);
        if (currentPull.headRefOid !== pull.headRefOid)
          throw new Error("pull request head changed during lifetime analysis");
      },
    });
  } catch (error) {
    await cleanupLifetimeStaging(staging, error);
    input.releaseTemporaryPath?.(staging);
    throw error;
  }
  input.releaseTemporaryPath?.(staging);
  return artifacts;
}
