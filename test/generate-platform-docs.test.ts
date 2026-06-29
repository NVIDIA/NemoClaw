// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAgentNameAlias } from "../src/lib/agent/defs";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "generate-platform-docs.py");

function runPython(script: string): string {
  return execFileSync("python3", ["-c", script, SCRIPT_PATH], {
    encoding: "utf-8",
  });
}

function loadGeneratorAs(name: string): string {
  return `
import importlib.util
import sys
import pathlib

spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, pathlib.Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;
}

describe("generate-platform-docs generator", () => {
  it("escapes pipes, newlines, CRLFs, and HTML control characters in table cells", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

print(module._escape_cell("a|b"))
print("---")
print(module._escape_cell("first\\nsecond"))
print("---")
print(module._escape_cell("crlf\\r\\nline"))
print("---")
# MDX would interpret raw <...> as JSX. Encode as HTML entities so the
# rendered page shows the original glyph but never parses it as a tag.
print(module._escape_cell("<MyComponent prop='x' />"))
print("---")
print(module._escape_cell("<script>alert(1)</script>"))
`);
    const sections = output.split("---\n").map((s) => s.trim());
    expect(sections[0]).toBe("a\\|b");
    expect(sections[1]).toBe("first second");
    // CRLF is collapsed to a single space (the \r\n branch runs first).
    expect(sections[2]).toBe("crlf line");
    expect(sections[3]).toBe("&lt;MyComponent prop='x' /&gt;");
    expect(sections[4]).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes MDX expression braces in table cells", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

# MDX evaluates {expression}. A future matrix note that mentions a
# JSON snippet or destructuring pattern should not get parsed as JSX.
print(module._escape_cell("{user.name}"))
print("---")
print(module._escape_cell("config = {key: value}"))
`);
    const sections = output.split("---\n").map((s) => s.trim());
    expect(sections[0]).toBe("&#123;user.name&#125;");
    expect(sections[1]).toBe("config = &#123;key: value&#125;");
  });

  it("escapes pipes when rendered through a real platform table row", () => {
    const output = runPython(`
${loadGeneratorAs("g")}
import json

platforms = [{"name": "Pipe|Name", "runtimes": ["A|B"], "status": "tested", "notes": "a|b note"}]
print(module.generate_platform_table(platforms))
`);
    const dataRow = output.trim().split("\n").at(-1) ?? "";
    expect(dataRow).toContain("Pipe\\|Name");
    expect(dataRow).toContain("A\\|B");
    expect(dataRow).toContain("a\\|b note");
    // A row with N escaped pipes inside cells still has exactly 5 unescaped
    // pipes (4 columns → 5 separators); the escaped ones are preceded by `\`.
    const unescapedPipes = dataRow.match(/(?<!\\)\|/g) ?? [];
    expect(unescapedPipes.length).toBe(5);
  });

  it("rejects unknown status values via _validate_matrix", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

bad = {
  "statuses": {"tested": "Validated.", "caveated": "Limited."},
  "owners": {"engineering": "@NVIDIA/nemoclaw-maintainer"},
  "platforms": [{"name": "X", "runtimes": ["Docker"], "status": "shipped", "notes": "n"}],
  "providers": [], "agents": [], "integrations": [],
  "deployment_paths": [], "capabilities": [], "out_of_scope": []
}
try:
    module._validate_matrix(bad)
    print("NO_ERROR")
except ValueError as exc:
    print(str(exc))
`);
    expect(output).toContain("unknown status");
    expect(output).toContain("'shipped'");
    expect(output).not.toContain("NO_ERROR");
  });

  it("rejects placeholder owner values (TBD, TODO, see PR review, empty)", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

cases = ["TBD (see PR review)", "TBD", "TODO: pick", "FIXME", "see PR review", "", "n/a"]
for raw in cases:
    matrix = {
      "statuses": {"tested": "Validated."},
      "owners": {"engineering": raw},
      "platforms": [], "providers": [], "agents": [], "integrations": [],
      "deployment_paths": [], "capabilities": [], "out_of_scope": []
    }
    try:
        module._validate_matrix(matrix)
        print(f"ACCEPTED:{raw!r}")
    except ValueError:
        print(f"REJECTED:{raw!r}")
`);
    const lines = output.trim().split("\n");
    expect(lines.every((line) => line.startsWith("REJECTED:"))).toBe(true);
  });

  it("accepts a real engineering owner alias with a complete project_status block", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

matrix = {
  "statuses": {"tested": "Validated."},
  "owners": {"engineering": "@NVIDIA/nemoclaw-maintainer"},
  "project_status": {
    "stage": "alpha",
    "label": "Early preview",
    "since": "2026-03-16",
    "notes": "Maintainer-run, best-effort responses."
  },
  "platforms": [], "providers": [], "agents": [], "integrations": [],
  "deployment_paths": [], "capabilities": [], "out_of_scope": []
}
module._validate_matrix(matrix)
print("OK")
`);
    expect(output.trim()).toBe("OK");
  });

  // PRA-2 on #5712: matrix.get(section, []) used to silently accept a missing
  // top-level section and render an empty table. _validate_matrix now requires
  // each generator-backed section to be present and list-typed before render.
  it("rejects a matrix that is missing a generator-backed top-level section", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

matrix = {
  "statuses": {"tested": "Validated."},
  "owners": {"engineering": "@NVIDIA/nemoclaw-maintainer"},
  "project_status": {"stage":"a","label":"b","since":"c","notes":"d"},
  "platforms": [], "providers": [], "integrations": [],
  "deployment_paths": [], "capabilities": [], "out_of_scope": []
  # 'agents' intentionally omitted
}
try:
    module._validate_matrix(matrix)
    print("NO_ERROR")
except ValueError as exc:
    print(str(exc))
`);
    expect(output).toContain("required top-level section 'agents' is missing");
    expect(output).not.toContain("NO_ERROR");
  });

  it("rejects a top-level section that is the wrong type (not a list)", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

matrix = {
  "statuses": {"tested": "Validated."},
  "owners": {"engineering": "@NVIDIA/nemoclaw-maintainer"},
  "project_status": {"stage":"a","label":"b","since":"c","notes":"d"},
  "platforms": [], "providers": [], "agents": "oops-a-string",
  "integrations": [], "deployment_paths": [], "capabilities": [], "out_of_scope": []
}
try:
    module._validate_matrix(matrix)
    print("NO_ERROR")
except ValueError as exc:
    print(str(exc))
`);
    expect(output).toContain("'agents' must be a list");
    expect(output).toContain("got str");
    expect(output).not.toContain("NO_ERROR");
  });

  it("rejects an incomplete project_status block (matches the validator's failure mode)", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

matrix = {
  "statuses": {"tested": "Validated."},
  "owners": {"engineering": "@NVIDIA/nemoclaw-maintainer"},
  "project_status": {"stage": "alpha", "label": "Early preview"},
  "platforms": [], "providers": [], "agents": [], "integrations": [],
  "deployment_paths": [], "capabilities": [], "out_of_scope": []
}
try:
    module._validate_matrix(matrix)
    print("NO_ERROR")
except ValueError as exc:
    print(str(exc))
`);
    expect(output).toContain("project_status missing required keys");
    expect(output).toContain("since");
    expect(output).toContain("notes");
    expect(output).not.toContain("NO_ERROR");
  });

  // PRA-4 on #5345: the partial provider table renders the canonical label
  // for caveated entries, omits deferred entries, and escapes pipes across
  // name, endpoint type, and notes so a future matrix edit cannot break the
  // launch-claims page.
  it("provider table uses canonical labels, excludes deferred entries, and escapes pipes across all cells", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

providers = [
  {"name": "Caveated|Provider", "status": "caveated", "endpoint_type": "Type|A", "notes": "note|A"},
  {"name": "Deferred|Provider", "status": "deferred", "endpoint_type": "Type|B", "notes": "note|B"},
]
print(module.generate_provider_table(providers))
`);
    const lines = output.trim().split("\n");
    const dataRows = lines.slice(2);
    expect(dataRows).toHaveLength(1);
    const row = dataRows[0];
    expect(row).toContain("Caveated\\|Provider");
    expect(row).toContain("Tested with limitations");
    expect(row).not.toContain("Caveated |");
    expect(row).toContain("Type\\|A");
    expect(row).toContain("note\\|A");
    expect(output).not.toContain("Deferred\\|Provider");
  });

  it("full platform table includes deferred rows; partial table excludes them", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

platforms = [
  {"name": "Linux", "runtimes": ["Docker"], "status": "tested", "ci_tested": True, "notes": "n"},
  {"name": "WSL", "runtimes": ["Docker"], "status": "deferred", "ci_tested": False, "notes": "later"}
]
print("PARTIAL:")
print(module.generate_platform_table(platforms))
print("FULL:")
print(module.generate_platform_table_full(platforms))
`);
    const [partial, full] = output.split("FULL:");
    expect(partial).toContain("Linux");
    expect(partial).not.toContain("WSL");
    expect(full).toContain("Linux");
    expect(full).toContain("WSL");
  });

  it("exits non-zero for --check on a placeholder owner in the real matrix", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "genplatform-"));
    const matrixPath = path.join(tmp, "matrix.json");
    writeFileSync(
      matrixPath,
      JSON.stringify({
        statuses: { tested: "Validated." },
        owners: { engineering: "TBD" },
        platforms: [],
        providers: [],
        agents: [],
        integrations: [],
        deployment_paths: [],
        capabilities: [],
        out_of_scope: [],
      }),
    );

    const result = spawnSync(
      "python3",
      [
        "-c",
        `
${loadGeneratorAs("g")}
matrix = module.load_matrix.__globals__["json"].load(open("${matrixPath}"))
try:
    module._validate_matrix(matrix)
    raise SystemExit(0)
except ValueError as exc:
    print(str(exc))
    raise SystemExit(2)
`,
        SCRIPT_PATH,
      ],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(2);
    // Either error path is acceptable: engineering-is-placeholder OR
    // engineering-must-be-real-alias. Just assert it surfaced as a validation error.
    expect(`${result.stdout}${result.stderr}`).toMatch(/owners\.engineering|placeholder/);
  });

  it("generate_owners_block emits engineering owner only (no product owner row)", () => {
    const output = runPython(`
${loadGeneratorAs("g")}

block = module.generate_owners_block({"engineering": "@NVIDIA/nemoclaw-maintainer"})
print(block)
`);
    expect(output).toContain("Engineering owner:");
    expect(output).toContain("@NVIDIA/nemoclaw-maintainer");
    expect(output).not.toContain("Product owner");
    expect(output).not.toContain("TBD");
  });

  // PRA-3 on #5345: semantic regression tests for launch-claim and
  // credential-boundary invariants. Each test reads the actual matrix and
  // docs at the PR head, not a fixture, so a future edit that breaks the
  // invariant fails this suite before the change ships.
  it("every `--agent <id>` example across matrix, docs, and generated skills resolves to a manifest whose name field agrees", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const matrix = JSON.parse(
      readFileSync(path.join(repoRoot, "ci", "platform-matrix.json"), "utf-8"),
    );
    const onboardExample = /(?:\$\$)?nemoclaw onboard --agent ([a-z0-9-]+)/g;
    const agentIds = new Set<string>();
    for (const section of ["agents", "out_of_scope"] as const) {
      for (const row of matrix[section] ?? []) {
        const notes: string = row.notes ?? "";
        for (const match of notes.matchAll(onboardExample)) agentIds.add(match[1]);
      }
    }
    const docTargets = [
      "docs/get-started/quickstart-langchain-deepagents-code.mdx",
      "docs/reference/platform-support.mdx",
    ].filter((rel) => existsSync(path.join(repoRoot, rel)));
    for (const rel of docTargets) {
      const body = readFileSync(path.join(repoRoot, rel), "utf-8");
      for (const match of body.matchAll(onboardExample)) agentIds.add(match[1]);
    }
    expect(agentIds.size).toBeGreaterThan(0);
    const agentsRoot = path.join(repoRoot, "agents");
    const availableAgents = ["openclaw", "hermes", "langchain-deepagents-code"];
    for (const id of agentIds) {
      const canonicalId = resolveAgentNameAlias(id, availableAgents) ?? id;
      const manifest = path.join(agentsRoot, canonicalId, "manifest.yaml");
      expect(
        existsSync(manifest),
        `\`--agent ${id}\` advertised somewhere in matrix/docs/skills but neither aliases nor agents/${id}/manifest.yaml resolve it`,
      ).toBe(true);
      const manifestBody = readFileSync(manifest, "utf-8");
      const nameMatch = manifestBody.match(/^name:\s*([a-z0-9-]+)\s*$/m);
      expect(
        nameMatch?.[1],
        `agents/${canonicalId}/manifest.yaml lacks a name field`,
      ).toBeDefined();
      expect(
        nameMatch?.[1],
        `agents/${canonicalId}/manifest.yaml declares name ${nameMatch?.[1]}, breaking the loader contract for documented \`--agent ${id}\``,
      ).toBe(canonicalId);
    }
  });

  it("out-of-scope LangChain row scopes itself and names Deep Agents Code as the integrated exception", () => {
    const matrixPath = path.join(import.meta.dirname, "..", "ci", "platform-matrix.json");
    const matrix = JSON.parse(readFileSync(matrixPath, "utf-8"));
    const langchainRow = (matrix.out_of_scope ?? []).find(
      (row: { name: string; notes: string }) =>
        /LangChain/i.test(row.name) || /LangChain/i.test(row.notes),
    );
    expect(langchainRow, "expected an out_of_scope row mentioning LangChain").toBeDefined();
    expect(langchainRow.name + " " + langchainRow.notes).toMatch(/Deep Agents Code/);
    expect(langchainRow.notes).not.toMatch(/Only OpenClaw and Hermes are integrated\.?\s*$/);
  });

  it("every `path:line` citation embedded in matrix notes resolves to a non-empty line in the repo", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const matrix = JSON.parse(
      readFileSync(path.join(repoRoot, "ci", "platform-matrix.json"), "utf-8"),
    );
    const citationRe = /([a-z][a-z0-9_/.-]*\.(?:ts|sh|py|yaml|yml|mdx|md|json)):(\d+)/gi;
    const citations: Array<{ section: string; file: string; line: number }> = [];
    for (const section of [
      "platforms",
      "providers",
      "agents",
      "integrations",
      "deployment_paths",
      "capabilities",
      "out_of_scope",
    ] as const) {
      for (const row of matrix[section] ?? []) {
        const notes: string = row.notes ?? "";
        for (const match of notes.matchAll(citationRe)) {
          citations.push({ section, file: match[1], line: Number(match[2]) });
        }
      }
    }
    expect(citations.length).toBeGreaterThan(0);
    for (const { section, file, line } of citations) {
      const fullPath = path.join(repoRoot, file);
      expect(
        existsSync(fullPath),
        `${section} row cites ${file}:${line} but ${file} is missing`,
      ).toBe(true);
      const fileBody = readFileSync(fullPath, "utf-8").split(/\r?\n/);
      expect(
        line <= fileBody.length,
        `${section} row cites ${file}:${line} but ${file} only has ${fileBody.length} lines`,
      ).toBe(true);
      expect(
        fileBody[line - 1].trim(),
        `${section} row cites ${file}:${line} but that line is empty`,
      ).not.toBe("");
    }
  });

  it("Option 3 docs expose reasoning mode for scripted compatible endpoints (#3279)", () => {
    const body = readFileSync(
      path.join(import.meta.dirname, "..", "docs", "inference", "inference-options.mdx"),
      "utf-8",
    );
    expect(body).toContain("| `NEMOCLAW_REASONING` |");
    expect(body).toContain("Set `NEMOCLAW_REASONING=true` when the compatible endpoint");
  });

  // PRA-2 on #5712 follow-up: a canonical launch-claims page that lives in the
  // repo but never appears in docs/index.yml is invisible on the published
  // site. Pin the registration so removing the nav entry fails CI before
  // the docs build silently drops the page.
  it("docs/index.yml registers the canonical Platform Support page in every Reference section", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const indexYaml = readFileSync(path.join(repoRoot, "docs", "index.yml"), "utf-8");

    const referenceSectionRe =
      /- section: "Reference"[\s\S]*?(?=\n {10}- section:|\n {6}- tab:|\Z)/g;
    const sections = [...indexYaml.matchAll(referenceSectionRe)];
    expect(
      sections.length,
      "expected at least one Reference section in docs/index.yml",
    ).toBeGreaterThan(0);
    for (const section of sections) {
      expect(
        section[0],
        "Reference section in docs/index.yml does not register reference/platform-support.mdx",
      ).toMatch(/path:\s*reference\/platform-support\.mdx/);
    }
  });
});
