// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expandProposal } from "../src/inference.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { stringify, parse } from "yaml";
import { run } from "../src/entry.js";
import {
  reconcile,
  reassessBranch,
  sourceUrl,
  configSchema,
  validateMapping,
  type Branch,
} from "../src/model.js";
import { Repository } from "../src/git.js";

test("real Git discovery, reconciliation, manual rebuild and failed inference preserve working artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "process-window-"));
  const repoPath = join(directory, "repository");
  await mkdir(repoPath);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(
    join(repoPath, "instructions.ts"),
    'export const prompt = "Read the architecture before coding";\n',
  );
  await mkdir(join(repoPath, "acceptance-references"));
  await writeFile(
    join(repoPath, "acceptance-references", "private.md"),
    "Must never reach inference",
  );
  git("add", ".");
  git("commit", "-qm", "Initial guidance");
  const revision = git("rev-parse", "HEAD");
  let invalid = "";
  let latestRevision = revision;
  let sawRead = false;
  let sawDiff = false;
  let sawCorrection = false;
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (invalid === "provider") {
        res.statusCode = 503;
        res.end("Do not expose provider error body");
        return;
      }
      assert.ok(!body.includes("Must never reach inference"));
      const context = JSON.parse(request.messages[1].content);
      if (context.existingMapping) {
        assert.equal(context.existingMapping.inputs[0].name, "Manual name");
        assert.ok(context.committedMapping.includes("Architecture prompt"));
        sawDiff = context.changes.includes("updated guidance");
      }
      const last = request.messages.at(-1);
      if (
        invalid === "repair-once" &&
        last.role === "user" &&
        last.content.includes("failed validation")
      ) {
        assert.match(last.content, /inputs.0.displayName: too_big/);
        sawCorrection = true;
        invalid = "";
      }
      let message: unknown;
      if (last.role !== "tool")
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read1",
              type: "function",
              function: {
                name: "read_files",
                arguments: JSON.stringify({ paths: ["instructions.ts"] }),
              },
            },
          ],
        };
      else {
        sawRead = last.content.includes("Read the architecture");
        message = {
          role: "assistant",
          content:
            invalid === "json"
              ? "{invalid"
              : JSON.stringify({
                  id: "main",
                  revision: invalid === "revision" ? "f".repeat(40) : latestRevision,
                  inputs: [
                    {
                      id: "prompt",
                      name: "Architecture prompt",
                      category: invalid === "category" ? "unknown" : "prompts",
                      stages: ["before"],
                      source: { path: "instructions.ts", start: invalid === "source" ? 2 : 1 },
                      evidence: "The prompt directs architecture review before coding.",
                    },
                  ],
                  mechanisms: [
                    {
                      id: "context-loader",
                      name: "Context loader",
                      usages: [
                        {
                          stage: "before",
                          trigger: "Agent starts",
                          inputIds: [invalid === "usage-input" ? "missing" : "prompt"],
                          basis: "verified",
                          agentUse:
                            invalid === "missing-agent-use"
                              ? undefined
                              : "The coding agent receives this prompt as context.",
                          source: {
                            path: "instructions.ts",
                            start: invalid === "usage-source" ? 2 : 1,
                          },
                          evidence: "Fixture loader supplies the prompt.",
                          outcome: "Architecture context",
                          requirements: [
                            {
                              inputIds: ["prompt"],
                              level: "conditional",
                              condition: "The contributor plans an architecture change.",
                              evidence:
                                "The planning procedure names this prompt for architecture changes.",
                              source: {
                                path: "instructions.ts",
                                start: invalid === "requirement-source" ? 2 : 1,
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                }),
        };
      }
      if (
        request.messages[0].content.startsWith("You independently assess") &&
        last.role === "tool"
      )
        message = {
          role: "assistant",
          content: JSON.stringify({
            id: "main",
            revision: latestRevision,
            assessments: [
              {
                mechanismId: "context-loader",
                stage: "before",
                requirements: [
                  {
                    inputIds: ["prompt"],
                    level: "conditional",
                    condition: "The contributor plans an architecture change.",
                    evidence: "Read the architecture prompt for this kind of change.",
                    source: { path: "instructions.ts", start: 1 },
                  },
                ],
              },
            ],
          }),
        };
      if (request.messages[0].content.includes("EXPLICIT REASSESSMENT:") && last.role === "tool") {
        const proposal = JSON.parse((message as { content: string }).content);
        proposal.inputs[0].displayName =
          invalid === "repair-once" ? "x".repeat(81) : "Review generated documentation";
        proposal.inputs[0].stages = ["after"];
        const usage = proposal.mechanisms[0].usages[0];
        usage.stage = "after";
        usage.summary = "After a code merge, an agent reviews generated docs before publication.";
        usage.lifecycle = {
          event: "Code merge triggers documentation review",
          source: { path: "instructions.ts", start: invalid === "lifecycle-source" ? 999 : 1 },
        };
        usage.phaseReason = "The review occurs inside the post-merge workflow.";
        delete usage.requirements;
        message = { role: "assistant", content: JSON.stringify(proposal) };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config = {
    repository: { path: repoPath, url: "https://github.com/example/repo", forge: "github" },
    mapping: "mapping.yaml",
    output: "site",
    stages: [
      { id: "before", name: "Before coding" },
      { id: "after", name: "After merge" },
    ],
    categories: [{ id: "prompts", name: "Prompts" }],
    branches: [
      { id: "main", name: "Main", ref: "HEAD", color: "#3475ad", refresh: { mode: "manual" } },
    ],
    inference: {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-fixture",
    },
  };
  const configPath = join(directory, "config.yaml");
  await writeFile(configPath, stringify(config));
  try {
    await run("analyze", configPath);
    assert.ok(sawRead);
    const mappingPath = join(directory, "mapping.yaml");
    const rootGit = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    rootGit("init", "-q");
    rootGit("config", "user.name", "Test");
    rootGit("config", "user.email", "test@example.invalid");
    rootGit("add", "mapping.yaml");
    rootGit("commit", "-qm", "Record discovered mapping");
    const mapping = parse(await readFile(mappingPath, "utf8"));
    mapping.branches[0].inputs[0].name = "Manual name";
    await writeFile(mappingPath, stringify(mapping));
    await run("build", configPath);
    assert.match(await readFile(join(directory, "site/index.html"), "utf8"), /Manual name/);
    await writeFile(
      join(repoPath, "instructions.ts"),
      'export const prompt = "Read the architecture: updated guidance";\n',
    );
    git("add", ".");
    git("commit", "-qm", "Update guidance");
    latestRevision = git("rev-parse", "HEAD");
    await assert.rejects(run("assess", configPath), /configured revision/);
    await run("analyze", configPath);
    assert.ok(sawDiff);
    const updated = parse(await readFile(mappingPath, "utf8"));
    assert.equal(updated.branches[0].revision, latestRevision);
    assert.equal(updated.branches[0].inputs[0].name, "Manual name");
    assert.match(updated.branches[0].inputs[0].note, /Unresolved/);
    await run("assess", configPath);
    const before = await readFile(mappingPath, "utf8");
    const site = await readFile(join(directory, "site/index.html"), "utf8");
    for (const failure of [
      "json",
      "revision",
      "category",
      "source",
      "provider",
      "usage-input",
      "usage-source",
      "requirement-source",
      "missing-agent-use",
    ]) {
      invalid = failure;
      await assert.rejects(run("analyze", configPath));
      assert.equal(await readFile(mappingPath, "utf8"), before);
      assert.equal(await readFile(join(directory, "site/index.html"), "utf8"), site);
    }
    invalid = "lifecycle-source";
    await assert.rejects(run("reassess", configPath), /Lifecycle evidence outside file/);
    assert.equal(await readFile(mappingPath, "utf8"), before);
    assert.equal(await readFile(join(directory, "site/index.html"), "utf8"), site);
    invalid = "repair-once";
    await run("reassess", configPath);
    assert.ok(sawCorrection, "Invalid display copy is corrected without restarting discovery");
    const corrected = parse(await readFile(mappingPath, "utf8")).branches[0];
    assert.deepEqual(corrected.inputs[0].stages, ["after"]);
    assert.equal(corrected.mechanisms[0].usages[0].stage, "after");
    assert.equal(corrected.inputs[0].displayName, "Review generated documentation");
    assert.equal(corrected.mechanisms[0].usages[0].requirements, undefined);
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() =>
      new Repository(repoPath).read(revision, "acceptance-references/private.md"),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

test("classification conflicts and omitted decisions remain visible", () => {
  const old: Branch = {
    id: "main",
    revision: "a".repeat(40),
    inputs: [
      {
        id: "guide",
        name: "Guide",
        category: "docs",
        stages: ["before"],
        source: { path: "guide.md", start: 1 },
        evidence: "Read first",
      },
    ],
  };
  const changed = structuredClone(old);
  changed.inputs[0]!.category = "prompts";
  changed.inputs[0]!.stages = ["after"];
  const result = reconcile(old, changed);
  assert.equal(result.inputs[0]!.category, "docs");
  assert.deepEqual(result.inputs[0]!.stages, ["before"]);
  assert.match(result.inputs[0]!.note!, /prompts/);
  assert.match(reconcile(old, { ...old, inputs: [] }).inputs[0]!.note!, /omitted/);
});

test("source URLs pin revisions and validation rejects unsafe sources and inconsistent classifications", () => {
  const config = configSchema.parse({
    repository: { path: ".", url: "https://gitlab.example/group/repo", forge: "gitlab" },
    mapping: "map.yaml",
    output: "site",
    stages: [{ id: "before", name: "Before" }],
    categories: [{ id: "docs", name: "Docs" }],
    branches: [
      { id: "main", name: "Main", ref: "HEAD", color: "#123456", refresh: { mode: "manual" } },
    ],
    inference: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      model: "model",
    },
  });
  const input = {
    id: "guide",
    name: "Guide",
    category: "docs",
    stages: ["before"],
    source: { path: "docs/a b.md", start: 2, end: 5 },
    evidence: "Read first",
  };
  assert.equal(
    sourceUrl(config, "a".repeat(40), input),
    `https://gitlab.example/group/repo/-/blob/${"a".repeat(40)}/docs/a%20b.md#L2-5`,
  );
  const mapping = {
    version: 1,
    repository: config.repository.url,
    branches: [{ id: "main", revision: "a".repeat(40), inputs: [input] }],
  };
  validateMapping(mapping, config);
  validateMapping(
    { ...mapping, branches: [{ ...mapping.branches[0], inputs: [{ ...input, stages: [] }] }] },
    config,
  );
  for (const path of ["../secret", "/secret", "acceptance-references/guidance.png"])
    assert.throws(() =>
      validateMapping(
        {
          ...mapping,
          branches: [
            { ...mapping.branches[0], inputs: [{ ...input, source: { path, start: 1 } }] },
          ],
        },
        config,
      ),
    );
  assert.throws(() =>
    validateMapping(
      {
        ...mapping,
        branches: [{ ...mapping.branches[0], inputs: [{ ...input, stages: ["wrong"] }] }],
      },
      config,
    ),
  );
  assert.throws(() =>
    validateMapping(
      { ...mapping, branches: [{ ...mapping.branches[0], inputs: [input, input] }] },
      config,
    ),
  );
});

test("repository search can reach guidance beyond the first hundred matches and narrow source paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "process-window-search-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await mkdir(join(dir, "source"));
    for (let i = 0; i < 103; i++)
      await writeFile(
        join(dir, "source", `${String(i).padStart(3, "0")}.ts`),
        "// Guidance: inspect the boundary\n",
      );
    await mkdir(join(dir, "acceptance-references"));
    await writeFile(join(dir, "acceptance-references", "hidden.md"), "Guidance must stay hidden");
    git("add", ".");
    git("commit", "-qm", "Source guidance");
    const repo = new Repository(dir);
    const revision = repo.revision("HEAD");
    const first = repo.search(revision, "guidance");
    assert.equal(first.total, 103);
    assert.equal(first.hits.length, 100);
    assert.equal(first.nextOffset, 100);
    const second = repo.search(revision, "guidance", "", first.nextOffset!);
    assert.equal(second.hits.length, 3);
    assert.equal(second.nextOffset, null);
    assert.equal(repo.search(revision, "guidance", "102.ts").hits[0]!.path, "source/102.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("usage references require phase membership and evidence; reconciliation preserves disputed decisions", () => {
  const config = configSchema.parse({
    repository: { path: ".", url: "https://github.com/example/repo", forge: "github" },
    mapping: "map.yaml",
    output: "site",
    stages: [
      { id: "before", name: "Before" },
      { id: "after", name: "After" },
    ],
    categories: [{ id: "docs", name: "Docs" }],
    branches: [
      { id: "main", name: "Main", ref: "HEAD", color: "#123456", refresh: { mode: "manual" } },
    ],
    inference: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      model: "model",
    },
  });
  const old: Branch = {
    id: "main",
    revision: "a".repeat(40),
    inputs: [
      {
        id: "guide",
        name: "Guide",
        category: "docs",
        stages: ["before"],
        source: { path: "guide.md", start: 1 },
        evidence: "Read first",
      },
    ],
    mechanisms: [
      {
        id: "workflow",
        name: "Planning workflow",
        usages: [
          {
            stage: "before",
            trigger: "Contributor starts planning",
            inputIds: ["guide"],
            basis: "prescribed",
            agentUse: "The coding agent is instructed to consult this guide.",
            source: { path: "workflow.md", start: 4 },
            evidence: "The workflow asks the contributor to consult the guide.",
            outcome: "Plan follows the repository conventions.",
          },
        ],
      },
    ],
  };
  const validate = (branch: Branch) =>
    validateMapping({ version: 1, repository: config.repository.url, branches: [branch] }, config);
  validate(old);
  for (const mutation of [
    (u: any) => {
      u.inputIds = ["missing"];
    },
    (u: any) => {
      u.stage = "after";
    },
    (u: any) => {
      delete u.source;
    },
    (u: any) => {
      delete u.agentUse;
    },
    (u: any) => {
      u.basis = "unresolved";
    },
  ]) {
    const invalid = structuredClone(old);
    mutation(invalid.mechanisms![0]!.usages[0]);
    assert.throws(() => validate(invalid));
  }
  const changed = structuredClone(old);
  changed.mechanisms![0]!.usages[0]!.trigger = "Automatic";
  const result = reconcile(old, changed);
  validate(result);
  assert.equal(result.mechanisms![0]!.usages[0]!.trigger, "Contributor starts planning");
  assert.equal(result.mechanisms![0]!.usages[0]!.basis, "unresolved");
  assert.match(result.mechanisms![0]!.usages[0]!.note!, /Automatic/);
  const relocated = structuredClone(old);
  relocated.inputs[0]!.stages = ["after"];
  relocated.mechanisms![0]!.usages[0]!.stage = "after";
  const kept = reconcile(old, relocated);
  validate(kept);
  const proposedUse = kept.mechanisms![0]!.usages.find((u) => u.stage === "after")!;
  assert.equal(proposedUse.basis, "unresolved");
  assert.match(proposedUse.note!, /retained phase classifications/);
  assert.deepEqual(kept.inputs[0]!.stages, ["before"]);
  assert.deepEqual(
    reconcile(kept, structuredClone(kept)),
    kept,
    "Repeated reconciliation must not duplicate conflict notes",
  );
  assert.match(
    reconcile(old, { ...old, mechanisms: [] }).mechanisms![0]!.usages[0]!.note!,
    /omitted/,
  );
  const compact = expandProposal(
    {
      id: old.id,
      revision: old.revision,
      inputs: [],
      unchangedInputIds: ["guide"],
      mechanisms: old.mechanisms,
    },
    old,
  );
  assert.deepEqual(compact.inputs, old.inputs);
  validate(compact);
  assert.throws(() => expandProposal({ ...old, unchangedInputIds: ["guide"] }, old));
  assert.throws(() => expandProposal({ ...old, inputs: [], unchangedInputIds: ["missing"] }, old));
  assert.throws(() => expandProposal({ ...old, inputs: [], unchangedInputIds: ["guide"] }));
});

test("requirement assessments preserve the inventory and reject incomplete or ambiguous coverage", async () => {
  const { expandAssessments } = await import("../src/inference.js");
  const config = configSchema.parse({
    repository: { path: ".", url: "https://github.com/example/repo", forge: "github" },
    mapping: "map.yaml",
    output: "site",
    stages: [{ id: "plan", name: "Plan" }],
    categories: [{ id: "docs", name: "Docs" }],
    branches: [
      { id: "main", name: "Main", ref: "HEAD", color: "#123456", refresh: { mode: "manual" } },
    ],
    inference: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      model: "test",
    },
  });
  const before: Branch = {
    id: "main",
    revision: "a".repeat(40),
    inputs: [
      {
        id: "guide",
        name: "Guide",
        category: "docs",
        stages: ["plan"],
        source: { path: "guide.md", start: 1 },
        evidence: "Reference",
      },
    ],
    mechanisms: [
      {
        id: "planner",
        name: "Planner",
        usages: [
          {
            stage: "plan",
            trigger: "Planning a change",
            inputIds: ["guide"],
            basis: "prescribed",
            agentUse: "The coding agent is instructed to consult this guide.",
            source: { path: "planner.md", start: 2 },
            evidence: "The workflow names the guide.",
            outcome: "Plan",
          },
        ],
      },
    ],
  };
  const row = {
    inputIds: ["guide"],
    level: "conditional" as const,
    condition: "The planned change alters authentication.",
    evidence: "Read the security guide for authentication changes.",
    source: { path: "planner.md", start: 2 },
  };
  const response = {
    id: before.id,
    revision: before.revision,
    assessments: [{ mechanismId: "planner", stage: "plan", requirements: [row] }],
  };
  const after = expandAssessments(response, before);
  const validate = (b: Branch) =>
    validateMapping({ version: 1, repository: config.repository.url, branches: [b] }, config);
  validate(after);
  assert.deepEqual(after.inputs, before.inputs);
  assert.equal(after.mechanisms![0]!.usages[0]!.basis, "prescribed");
  assert.equal(before.mechanisms![0]!.usages[0]!.requirements, undefined);
  for (const requirements of [
    [{ ...row, condition: undefined }],
    [{ ...row, level: "mandatory" }],
    [{ ...row, inputIds: ["unknown"] }],
    [row, row],
  ])
    assert.throws(() =>
      validate(
        expandAssessments(
          { ...response, assessments: [{ ...response.assessments[0], requirements }] },
          before,
        ),
      ),
    );
  assert.throws(() => expandAssessments({ ...response, assessments: [] }, before));
  assert.throws(() =>
    expandAssessments(
      { ...response, assessments: [...response.assessments, ...response.assessments] },
      before,
    ),
  );
  const changed = structuredClone(after);
  changed.mechanisms![0]!.usages[0]!.requirements![0]!.level = "available";
  delete changed.mechanisms![0]!.usages[0]!.requirements![0]!.condition;
  const retained = reconcile(after, changed);
  validate(retained);
  assert.equal(retained.mechanisms![0]!.usages[0]!.requirements![0]!.level, "conditional");
  assert.match(retained.mechanisms![0]!.usages[0]!.requirements![0]!.note!, /proposed available/);
});

test("explicit reassessment applies corrections but rejects identity loss and missing rationale", () => {
  const before: Branch = {
    id: "main",
    revision: "a".repeat(40),
    inputs: [
      {
        id: "prompt",
        name: "Prompt",
        category: "prompts",
        stages: ["local"],
        source: { path: "prompt.ts", start: 1 },
        evidence: "Prompt text",
      },
    ],
    mechanisms: [
      {
        id: "reviewer",
        name: "Reviewer",
        usages: [
          {
            stage: "local",
            trigger: "Review",
            inputIds: ["prompt"],
            basis: "verified",
            agentUse: "Reviewer receives prompt",
            source: { path: "run.ts", start: 1 },
            evidence: "Invocation",
            outcome: "Review",
          },
        ],
      },
    ],
  };
  const corrected = structuredClone(before);
  corrected.inputs[0]!.displayName = "Review generated docs";
  corrected.inputs[0]!.stages = ["after"];
  Object.assign(corrected.mechanisms![0]!.usages[0]!, {
    stage: "after",
    summary: "After merge, an agent reviews generated docs.",
    lifecycle: { event: "Main push", source: { path: "workflow.yml", start: 1 } },
    phaseReason: "Internal review within post-merge automation.",
  });
  assert.deepEqual(reassessBranch(before, corrected).inputs[0]!.stages, ["after"]);
  assert.deepEqual(reconcile(before, structuredClone(corrected)).inputs[0]!.stages, ["local"]);
  for (const mutate of [
    (b: Branch) => {
      b.inputs = [];
    },
    (b: Branch) => {
      b.mechanisms = [];
    },
    (b: Branch) => {
      b.revision = "b".repeat(40);
    },
    (b: Branch) => {
      delete b.mechanisms![0]!.usages[0]!.lifecycle;
    },
    (b: Branch) => {
      delete b.mechanisms![0]!.usages[0]!.summary;
    },
  ]) {
    const bad = structuredClone(corrected);
    mutate(bad);
    assert.throws(() => reassessBranch(before, bad));
  }
});

test("Responses analysis reads pinned Git content and saves its mapping and site", async () => {
  const directory = await mkdtemp(join(tmpdir(), "process-window-responses-"));
  const repoPath = join(directory, "repository");
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await mkdir(repoPath);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    const guidance = 'export const prompt = "Read architecture before coding";';
    await writeFile(join(repoPath, "instructions.ts"), `${guidance}\n`);
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Fixture guidance");
    const revision = git("rev-parse", "HEAD");
    await writeFile(
      join(repoPath, "instructions.ts"),
      "Uncommitted text must not reach inference\n",
    );
    const proposal = {
      id: "main",
      revision,
      inputs: [
        {
          id: "architecture",
          name: "Architecture prompt",
          category: "prompts",
          stages: ["before"],
          source: { path: "instructions.ts", start: 1 },
          evidence: "Prompt requests architecture review.",
        },
      ],
      mechanisms: [
        {
          id: "planning",
          name: "Planning context",
          usages: [
            {
              stage: "before",
              trigger: "Fixture agent plans a change",
              inputIds: ["architecture"],
              basis: "prescribed",
              agentUse: "Fixture agent consults the architecture prompt before coding.",
              source: { path: "instructions.ts", start: 1 },
              evidence: "Prompt directs architecture review.",
              outcome: "Plan informed by architecture",
            },
          ],
        },
      ],
    };
    const reasoning = {
      type: "reasoning",
      id: "rs_fixture",
      encrypted_content: "synthetic-state",
      summary: [],
    };
    const call = {
      type: "function_call",
      id: "fc_fixture",
      call_id: "read_fixture",
      name: "read_files",
      arguments: JSON.stringify({ paths: ["instructions.ts"] }),
    };
    let turns = 0;
    let serverError: unknown;
    server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        assert.equal(req.url, "/responses");
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        turns++;
        let output;
        if (turns === 1) {
          assert.equal(JSON.parse(body.input[1].content).revision, revision);
          output = [reasoning, call];
        } else {
          assert.equal(turns, 2);
          assert.deepEqual(body.input.slice(-3, -1), [reasoning, call]);
          const result = body.input.at(-1);
          assert.equal(result.type, "function_call_output");
          assert.equal(result.call_id, call.call_id);
          assert.deepEqual(JSON.parse(result.output), [
            { path: "instructions.ts", totalLines: 1, content: `1: ${guidance}` },
          ]);
          output = [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: JSON.stringify(proposal) }],
            },
          ];
        }
        res.setHeader("content-type", "text/event-stream");
        res.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output } })}\n\n`,
        );
      } catch (error) {
        serverError = error;
        res.statusCode = 500;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const configPath = join(directory, "config.yaml");
    await writeFile(
      configPath,
      stringify({
        repository: { path: repoPath, url: "https://github.com/example/repo", forge: "github" },
        mapping: "mapping.yaml",
        output: "site",
        stages: [{ id: "before", name: "Before coding" }],
        categories: [{ id: "prompts", name: "Prompts" }],
        branches: [
          {
            id: "main",
            name: "Main",
            ref: revision,
            color: "#3475ad",
            refresh: { mode: "manual" },
          },
        ],
        inference: {
          provider: "openai-compatible",
          api: "responses",
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: "synthetic-fixture",
          timeoutSeconds: 10,
          maxTurns: 3,
        },
      }),
    );
    try {
      await run("analyze", configPath);
    } catch (error) {
      throw serverError ?? error;
    }
    assert.equal(turns, 2);
    const saved = parse(await readFile(join(directory, "mapping.yaml"), "utf8"));
    assert.equal(saved.branches[0].revision, revision);
    assert.deepEqual(saved.branches[0].inputs, proposal.inputs);
    assert.equal(saved.branches[0].mechanisms[0].usages[0].basis, "prescribed");
    const site = await readFile(join(directory, "site/index.html"), "utf8");
    assert.ok(site.includes("Architecture prompt"));
    assert.ok(site.includes(revision));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
