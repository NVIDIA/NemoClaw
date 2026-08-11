// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";
import SandboxAgentCommand from "../src/commands/sandbox/agent";
import SandboxSessionsDeleteCommand from "../src/commands/sandbox/sessions/delete";
import SandboxSessionsExportCommand from "../src/commands/sandbox/sessions/export";
import SandboxSessionsListCommand from "../src/commands/sandbox/sessions/list";
import SandboxSessionsResetCommand from "../src/commands/sandbox/sessions/reset";
import {
  auditCommandExampleAgentIds,
  auditDocumentationAgentIds,
} from "./helpers/documented-agent-id-scanner";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "./helpers/openclaw-env-fixture";

const DOCS_ROOT = path.join(import.meta.dirname, "..", "docs");
const COMMANDS_DOC = path.join(DOCS_ROOT, "reference", "commands.mdx");

describe("agent ids in NemoClaw documentation and CLI examples (#8706)", () => {
  let tmpDir: string;
  let bakedAgentIds: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "documented-agent-ids-"));
    const env = buildOpenClawTestEnv(tmpDir, baseOpenClawGenerationEnv());
    const config = buildConfig(env) as {
      agents: { list: Array<{ id: string }> };
    };
    bakedAgentIds = config.agents.list.map((entry) => entry.id);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bakes exactly one agent id when onboarding declares no extra agents", () => {
    expect(bakedAgentIds).toEqual(["main"]);
  });

  it("restricts the command reference examples to baked agent ids", () => {
    const audit = auditDocumentationAgentIds(DOCS_ROOT, COMMANDS_DOC, bakedAgentIds);
    expect(audit.commandReferenceOffenders).toEqual([]);
  });

  it("restricts every documentation page outside the command reference to baked agent ids", () => {
    const audit = auditDocumentationAgentIds(DOCS_ROOT, COMMANDS_DOC, bakedAgentIds);
    expect(audit.otherPageOffenders).toEqual([]);
  });

  it("restricts the sandbox command examples to baked agent ids", () => {
    const commands = [
      SandboxAgentCommand,
      SandboxSessionsListCommand,
      SandboxSessionsResetCommand,
      SandboxSessionsDeleteCommand,
      SandboxSessionsExportCommand,
    ];
    const offenders = auditCommandExampleAgentIds(commands, bakedAgentIds);
    expect(offenders).toEqual([]);
  });

  it("reports unsupported dotted agent ids in flag and canonical-key examples", () => {
    const examples = [
      "nemoclaw sandbox sessions list --agent agent-42.beta",
      "nemoclaw sandbox sessions reset agent:agent-42.beta:main",
    ];
    const offenders = auditCommandExampleAgentIds(
      [{ id: "scanner-fixture", examples }],
      bakedAgentIds,
    );
    expect(offenders).toEqual(examples.map((example) => `scanner-fixture: ${example}`));
  });

  it("reports unsupported agent ids in tilde-fenced documentation examples", () => {
    const docsRoot = path.join(tmpDir, "docs");
    const commandReference = path.join(docsRoot, "reference", "commands.mdx");
    fs.mkdirSync(path.dirname(commandReference), { recursive: true });
    fs.writeFileSync(
      commandReference,
      "~~~sh\nnemoclaw sandbox sessions list --agent agent-42.beta\n~~~\n",
    );

    const audit = auditDocumentationAgentIds(docsRoot, commandReference, bakedAgentIds);
    expect(audit.commandReferenceOffenders).toEqual([
      "reference/commands.mdx:2 (any) -> nemoclaw sandbox sessions list --agent agent-42.beta",
    ]);
  });

  it("keeps mixed and shorter delimiter lines inside their opening fences", () => {
    const docsRoot = path.join(tmpDir, "docs");
    const commandReference = path.join(docsRoot, "reference", "commands.mdx");
    const otherPage = path.join(docsRoot, "short-closing-fence.mdx");
    fs.mkdirSync(path.dirname(commandReference), { recursive: true });
    fs.writeFileSync(
      commandReference,
      "~~~sh\nnemoclaw sandbox sessions list --agent main\n```\nnemoclaw sandbox sessions list --agent work\n~~~\n",
    );
    fs.writeFileSync(
      otherPage,
      "````sh\nnemoclaw sandbox sessions list --agent main\n```\nnemoclaw sandbox sessions list --agent work\n````\n",
    );

    const audit = auditDocumentationAgentIds(docsRoot, commandReference, bakedAgentIds);
    expect(audit.commandReferenceOffenders).toEqual([
      "reference/commands.mdx:4 (any) -> nemoclaw sandbox sessions list --agent work",
    ]);
    expect(audit.otherPageOffenders).toEqual([
      "short-closing-fence.mdx:4 -> nemoclaw sandbox sessions list --agent work",
    ]);
  });
});
