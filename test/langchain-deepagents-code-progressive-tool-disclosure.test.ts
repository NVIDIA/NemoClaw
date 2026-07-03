// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const middlewarePath = path.join(agentDir, "progressive_tool_disclosure.py");
const patcherPath = path.join(agentDir, "patch-managed-deepagents-code.py");
const harnessPath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "deepagents-progressive-disclosure-harness.py",
);

const MAIN_SOURCE = `import os
from types import SimpleNamespace

class Parser:
    def __init__(self):
        self.args = SimpleNamespace(
            command=None,
            sandbox='docker',
            sandbox_id='sandbox-id',
            sandbox_snapshot_name='snapshot',
            sandbox_setup='setup.sh',
            mcp_config='mcp.json',
            no_mcp=False,
            trust_project_mcp=True,
            shell_allow_list=['bash'],
        )

    def parse_args(self):
        return self.args

    def error(self, message):
        raise RuntimeError(message)

parser = Parser()

def parse_args():
    args = parser.parse_args()
    return args
`;

const AGENT_SOURCE = `from deepagents_code.project_utils import ProjectContext, get_server_project_context

def list_subagents(**_kwargs):
    return [{"name": "first"}, {"name": "second"}]

def create_summarization_tool_middleware(_model, _backend):
    return "summary-middleware"

def create_cli_agent(mcp_server_info=None):
    tools = None
    tools = tools or []
    effective_cwd = (
        None
    )
    user_agents_dir = effective_cwd
    project_agents_dir = effective_cwd
    subagent_stacks = []

    def _subagent_cli_middleware(*, has_explicit_model: bool):
        middleware: list[object] = []
        if has_explicit_model:
            middleware.append("explicit-model")
        return middleware

    for subagent_meta in list_subagents(
        user_agents_dir=user_agents_dir,
        project_agents_dir=project_agents_dir,
    ):
        subagent_stacks.append(
            _subagent_cli_middleware(has_explicit_model=bool(subagent_meta.get("model")))
        )

    agent_middleware = []
    model = None
    composite_backend = None
    agent_middleware.append(
        create_summarization_tool_middleware(model, composite_backend)
    )

    # Create the agent
    return agent_middleware, subagent_stacks
`;

const AGENT_ANCHORS = {
  import: "from deepagents_code.project_utils import ProjectContext, get_server_project_context\n",
  activation: "    tools = tools or []\n    effective_cwd = (\n",
  subagent: "        return middleware\n\n    for subagent_meta in list_subagents(\n",
  "main-agent": `    agent_middleware.append(
        create_summarization_tool_middleware(model, composite_backend)
    )

    # Create the agent
`,
} as const;
const MAIN_ANCHOR = "    args = parser.parse_args()\n";

interface PatchFixture {
  root: string;
  packageDir: string;
  mainPath: string;
  agentPath: string;
  modulePath: string;
}

function makePatchFixture(): PatchFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-disclosure-"));
  const packageDir = path.join(root, "deepagents_code");
  fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
  fs.writeFileSync(
    path.join(packageDir, "project_utils.py"),
    "ProjectContext = object\ndef get_server_project_context(): return None\n",
    "utf8",
  );
  const mainPath = path.join(packageDir, "main.py");
  const agentPath = path.join(packageDir, "agent.py");
  const modulePath = path.join(packageDir, "progressive_tool_disclosure.py");
  fs.writeFileSync(mainPath, MAIN_SOURCE, "utf8");
  fs.writeFileSync(agentPath, AGENT_SOURCE, "utf8");
  return { root, packageDir, mainPath, agentPath, modulePath };
}

function runPatcher(fixture: PatchFixture) {
  return spawnSync("python3", [patcherPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: fixture.root },
  });
}

function runHarness(scenario: "behavior" | "persistence" | "isolation", target = middlewarePath) {
  const result = spawnSync("python3", [harnessPath, scenario, target], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("Deep Agents progressive tool disclosure", () => {
  it("keeps only core tools visible and discovers name/description matches cumulatively", () => {
    const result = runHarness("behavior");
    expect(result.initial).toEqual(["ls", "search_tools", "read_file"]);
    expect(result.discovered).toEqual(["Weather_Forecast", "query_database"]);
    expect(result.async).toEqual([
      "Weather_Forecast",
      "ls",
      "query_database",
      "search_tools",
      "read_file",
    ]);
  });

  it("restores discovered tools after compaction and session reconstruction", () => {
    const result = runHarness("persistence");
    expect(result.resumed).toContain("Weather_Forecast");
    expect(result.unknown).not.toContain("Weather_Forecast");
  });

  it("isolates graph threads and local-subagent middleware instances", () => {
    const result = runHarness("isolation");
    expect(result.thread_a).toContain("Weather_Forecast");
    expect(result.thread_b).not.toContain("Weather_Forecast");
  });
});

describe("Deep Agents 0.1.12 build patch", () => {
  it("patches managed posture and isolated main/subagent wiring idempotently", () => {
    const fixture = makePatchFixture();
    const first = runPatcher(fixture);
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = [fixture.mainPath, fixture.agentPath, fixture.modulePath].map((file) =>
      fs.readFileSync(file, "utf8"),
    );

    const second = runPatcher(fixture);
    expect(second.status, second.stderr).toBe(0);
    expect(
      [fixture.mainPath, fixture.agentPath, fixture.modulePath].map((file) =>
        fs.readFileSync(file, "utf8"),
      ),
    ).toEqual(firstBytes);
    expect(firstBytes[0].match(/NemoClaw-managed sandbox image hardening\./g)).toHaveLength(1);
    expect(firstBytes[1].match(/ProgressiveToolDisclosureMiddleware\(\)/g)).toHaveLength(2);
    expect(firstBytes[2]).toBe(fs.readFileSync(middlewarePath, "utf8"));

    const managedPosture = execFileSync(
      "python3",
      [
        "-c",
        `import os
import deepagents_code.main as main
os.environ['DEEPAGENTS_CODE_SHELL_ALLOW_LIST'] = 'bash'
args = main.parse_args()
assert args.sandbox == 'none'
assert args.mcp_config is None and args.no_mcp is True
assert args.trust_project_mcp is False and args.shell_allow_list is None
assert 'DEEPAGENTS_CODE_SHELL_ALLOW_LIST' not in os.environ
main.parser.args.command = 'mcp'
try:
    main.parse_args()
except RuntimeError as exc:
    assert 'MCP commands are disabled' in str(exc)
else:
    raise AssertionError('mcp command did not fail')
print('managed-posture-ok')`,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: fixture.root } },
    );
    expect(managedPosture).toContain("managed-posture-ok");

    const wiring = spawnSync("python3", [harnessPath, "wiring", fixture.agentPath], {
      encoding: "utf8",
    });
    expect(wiring.status, wiring.stderr).toBe(0);
    expect(JSON.parse(wiring.stdout)).toEqual({ main: 1, subagents: 2 });
  });

  it.each(
    Object.entries(AGENT_ANCHORS).flatMap(([label, anchor]) => [
      [label, "missing", anchor],
      [label, "duplicate", anchor],
    ]),
  )("fails closed when the %s anchor is %s", (label, mode, anchor) => {
    const fixture = makePatchFixture();
    const originalMain = fs.readFileSync(fixture.mainPath, "utf8");
    const originalAgent = fs.readFileSync(fixture.agentPath, "utf8");
    fs.writeFileSync(
      fixture.agentPath,
      mode === "missing"
        ? originalAgent.replace(anchor, "")
        : originalAgent.replace(anchor, anchor + anchor),
      "utf8",
    );
    const driftedAgent = fs.readFileSync(fixture.agentPath, "utf8");

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Deep Agents Code ${label} marker not found exactly once`);
    expect(fs.readFileSync(fixture.mainPath, "utf8")).toBe(originalMain);
    expect(fs.readFileSync(fixture.agentPath, "utf8")).toBe(driftedAgent);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it.each([
    "missing",
    "duplicate",
  ] as const)("fails closed when the parser anchor is %s", (mode) => {
    const fixture = makePatchFixture();
    const originalMain = fs.readFileSync(fixture.mainPath, "utf8");
    const originalAgent = fs.readFileSync(fixture.agentPath, "utf8");
    const driftedMain =
      mode === "missing"
        ? originalMain.replace(MAIN_ANCHOR, "")
        : originalMain.replace(MAIN_ANCHOR, MAIN_ANCHOR + MAIN_ANCHOR);
    fs.writeFileSync(fixture.mainPath, driftedMain, "utf8");

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Deep Agents Code parser marker not found exactly once");
    expect(fs.readFileSync(fixture.mainPath, "utf8")).toBe(driftedMain);
    expect(fs.readFileSync(fixture.agentPath, "utf8")).toBe(originalAgent);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it("rejects a partial parser sentinel without writing other files", () => {
    const fixture = makePatchFixture();
    const originalAgent = fs.readFileSync(fixture.agentPath, "utf8");
    const partialMain = fs
      .readFileSync(fixture.mainPath, "utf8")
      .replace(MAIN_ANCHOR, `${MAIN_ANCHOR}    # NemoClaw-managed sandbox image hardening.\n`);
    fs.writeFileSync(fixture.mainPath, partialMain, "utf8");

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Deep Agents Code parser patch is incomplete");
    expect(fs.readFileSync(fixture.mainPath, "utf8")).toBe(partialMain);
    expect(fs.readFileSync(fixture.agentPath, "utf8")).toBe(originalAgent);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it("rejects a partial sentinel install without writing other files", () => {
    const fixture = makePatchFixture();
    fs.appendFileSync(
      fixture.agentPath,
      "\n# ProgressiveToolDisclosureMiddleware partial install\n",
      "utf8",
    );
    const originalMain = fs.readFileSync(fixture.mainPath, "utf8");
    const originalAgent = fs.readFileSync(fixture.agentPath, "utf8");

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("patch is incomplete");
    expect(fs.readFileSync(fixture.mainPath, "utf8")).toBe(originalMain);
    expect(fs.readFileSync(fixture.agentPath, "utf8")).toBe(originalAgent);
    expect(fs.existsSync(fixture.modulePath)).toBe(false);
  });

  it("refuses to overwrite a conflicting installed middleware module", () => {
    const fixture = makePatchFixture();
    fs.writeFileSync(fixture.modulePath, "# unexpected module\n", "utf8");
    const originalMain = fs.readFileSync(fixture.mainPath, "utf8");
    const originalAgent = fs.readFileSync(fixture.agentPath, "utf8");

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite unexpected middleware");
    expect(fs.readFileSync(fixture.mainPath, "utf8")).toBe(originalMain);
    expect(fs.readFileSync(fixture.agentPath, "utf8")).toBe(originalAgent);
    expect(fs.readFileSync(fixture.modulePath, "utf8")).toBe("# unexpected module\n");
  });
});
