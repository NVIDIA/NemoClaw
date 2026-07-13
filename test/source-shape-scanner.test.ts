// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  contractExceptionAllowlistErrors,
  scanTextForTest,
  scanTextForTestReport,
  sourceShapeSummary,
} from "../scripts/find-source-shape-tests";

function detectedCaseNames(source: string): string[] {
  return scanTextForTest("test/virtual-source-shape.test.ts", source).map((entry) => entry.name);
}

describe("source-shape scanner", () => {
  it("detects source reads through variable-declared arrow helpers", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      const loadSource = (repoPath: string) => readFileSync(path.join(process.cwd(), repoPath), "utf8");

      it("asserts source text", () => {
        const source = loadSource("src/lib/example.ts");
        expect(source).toContain("implementation detail");
      });
    `);

    expect(cases).toEqual(["asserts source text"]);
  });

  it("detects source-tree walks that feed source text assertions", () => {
    const cases = detectedCaseNames(`
      import fs from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      function collectProductionFiles(dir: string): string[] {
        return fs.readdirSync(dir).flatMap((entry) => {
          const absolute = path.join(dir, entry);
          const stats = fs.statSync(absolute);
          if (stats.isDirectory()) return collectProductionFiles(absolute);
          if (absolute.endsWith(".ts") && !absolute.endsWith(".test.ts")) return [absolute];
          return [];
        });
      }

      it("asserts import boundaries by reading source files", () => {
        const files = collectProductionFiles(path.join(process.cwd(), "src/lib/example"));
        for (const file of files) {
          const source = fs.readFileSync(file, "utf8");
          const specifiers = source.match(/node:fs/g) ?? [];
          expect(specifiers).toEqual([]);
        }
      });
    `);

    expect(cases).toEqual(["asserts import boundaries by reading source files"]);
  });

  it("detects direct assertions against source-tree helper results", () => {
    const cases = detectedCaseNames(`
      import fs from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      function expectedIds(dir = path.join(process.cwd(), "src/commands")): string[] {
        return fs.readdirSync(dir).flatMap((entry) => {
          if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) return [];
          return [entry.replace(/\\.ts$/, "")];
        });
      }

      it("asserts discovered command ids", () => {
        expect(["onboard"]).toEqual(expectedIds());
      });
    `);

    expect(cases).toEqual(["asserts discovered command ids"]);
  });

  it("detects source reads through variable-declared function expression helpers", () => {
    const cases = detectedCaseNames(`
      import fs from "node:fs";
      import path from "node:path";
      import { expect, it } from "vitest";

      const loadSource = function (repoPath: string) {
        return fs.readFileSync(path.join(process.cwd(), repoPath), "utf8");
      };

      it("asserts function-expression source text", () => {
        const source = loadSource("scripts/example.sh");
        expect(source).not.toContain("implementation detail");
      });
    `);

    expect(cases).toEqual(["asserts function-expression source text"]);
  });

  it("does not treat uncalled source-reader helpers as source text", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import { expect, it } from "vitest";

      const loadSource = () => readFileSync("src/lib/example.ts", "utf8");

      it("asserts helper shape only", () => {
        expect(loadSource).toBeTypeOf("function");
      });
    `);

    expect(cases).toEqual([]);
  });

  it("detects direct assertions on shipped declarative files", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import YAML from "yaml";
      import { expect, it } from "vitest";

      it("mirrors blueprint keys", () => {
        const config = YAML.parse(readFileSync("nemoclaw-blueprint/blueprint.yaml", "utf8")); expect(config.components).toHaveProperty("sandbox");
      });

      it("mirrors an E2E manifest", () => {
        const target = JSON.parse(readFileSync("test/e2e/targets/cloud.json", "utf8")); expect(target.requiredSecrets).toEqual(["NVIDIA_API_KEY"]);
      });
    `);

    expect(cases).toEqual(["mirrors blueprint keys", "mirrors an E2E manifest"]);
  });

  it("detects Node assertions and source-derived expected arguments", () => {
    const cases = detectedCaseNames(`
      import assert from "node:assert/strict";
      import nodeAssert, {
        deepStrictEqual as same,
        strict as strictAssert,
      } from "node:assert";
      import { readFileSync } from "node:fs";
      import { spawnSync } from "node:child_process";
      import { it } from "vitest";
      import { validateBlueprint } from "../src/lib/config-validator";

      const cjsSame = require("node:assert").deepEqual;
      const esmSame = nodeAssert.deepStrictEqual;
      const { deepEqual: destructuredSame } = nodeAssert;

      it("uses deep equality", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        assert.deepStrictEqual(raw.scripts, { test: "vitest" });
      });

      it("uses callable assert", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        assert(raw.private);
      });

      it("puts source data in the expected position", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        assert.equal("nemoclaw", raw.name);
      });

      it("uses an aliased default assertion", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        nodeAssert.deepEqual({}, raw.scripts);
      });

      it("uses an aliased named assertion", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        same({}, raw.scripts);
      });

      it("uses a strict namespace assertion", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        strictAssert.partialDeepStrictEqual({}, raw.scripts);
      });

      it("uses a nested strict assertion", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        nodeAssert.strict.deepStrictEqual({}, raw.scripts);
      });

      it("uses a property-extracted CommonJS assertion", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        cjsSame({}, raw.scripts);
      });

      it("uses a property-extracted ESM assertion", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        esmSame({}, raw.scripts);
      });

      it("uses a destructured assertion alias", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        destructuredSame({}, raw.scripts);
      });

      it("ignores a source-derived diagnostic message", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        assert.ok(true, \`package \${raw.name}\`);
      });

      it("asserts an execution result", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        const result = spawnSync("tool", [raw.name]);
        assert.equal(result.stdout, raw.name);
      });

      it("asserts production consumer behavior", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        assert.equal(validateBlueprint(raw).ok, raw.private);
      });
    `);

    expect(cases).toEqual([
      "uses deep equality",
      "uses callable assert",
      "puts source data in the expected position",
      "uses an aliased default assertion",
      "uses an aliased named assertion",
      "uses a strict namespace assertion",
      "uses a nested strict assertion",
      "uses a property-extracted CommonJS assertion",
      "uses a property-extracted ESM assertion",
      "uses a destructured assertion alias",
    ]);
  });

  it("detects repeated parent traversal from co-located tests", () => {
    const cases = scanTextForTest(
      "src/lib/actions/virtual-source-shape.test.ts",
      `
      import { readFileSync } from "node:fs";
      import { expect, it } from "vitest";

      it("reads a deep config path", () => {
        const raw = readFileSync("../../../nemoclaw-blueprint/blueprint.yaml", "utf8");
        expect(raw).toContain("version:");
      });

      it("reads a deep root file", () => {
        const raw = JSON.parse(readFileSync("../../../package.json", "utf8"));
        expect(raw.scripts).toHaveProperty("test");
      });
    `,
    ).map((entry) => entry.name);

    expect(cases).toEqual(["reads a deep config path", "reads a deep root file"]);
  });

  it("tracks source assignments from applicable setup hooks only", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import { beforeAll as setupAll, beforeEach, describe, expect, it } from "vitest";

      let globalRaw;
      function loadGlobalConfig() {
        globalRaw = JSON.parse(readFileSync("package.json", "utf8"));
      }
      const aliasedLoadGlobalConfig = loadGlobalConfig;
      setupAll(aliasedLoadGlobalConfig);

      it("uses top-level setup data", () => expect(globalRaw.name).toBe("nemoclaw"));

      describe("one suite", () => {
        let suiteRaw;
        beforeEach(() => {
          suiteRaw = JSON.parse(readFileSync("package.json", "utf8"));
        });
        it("uses suite setup data", () => expect(suiteRaw.private).toBe(true));
      });

      describe("sibling suite", () => {
        it("does not inherit a sibling hook", () => {
          const suiteRaw = { private: true };
          expect(suiteRaw.private).toBe(true);
        });
      });
    `);

    expect(cases).toEqual(["uses top-level setup data", "uses suite setup data"]);
  });

  it("detects CommonJS and dynamic declarative imports", () => {
    const cases = detectedCaseNames(`
      import { expect, it } from "vitest";

      it("requires package metadata", () => {
        const raw = require("../package.json");
        expect(raw.scripts).toHaveProperty("test");
      });

      it("dynamically imports package metadata", async () => {
        const raw = (await import("../package.json", { with: { type: "json" } })).default;
        expect(raw.name).toBe("nemoclaw");
      });

      it("chains a dynamic package import", async () => {
        const raw = await import("../package.json").then((module) => module.default);
        expect(raw.name).toBe("nemoclaw");
      });

      it("directly requires package metadata", () => {
        expect(require("../package.json").scripts).toHaveProperty("test");
      });

      it("directly imports package metadata", async () => {
        expect((await import("../package.json")).default.private).toBe(true);
      });

      it("ignores a required fixture", () => {
        expect(require("./fixtures/package.json").name).toBe("fixture");
      });
    `);

    expect(cases).toEqual([
      "requires package metadata",
      "dynamically imports package metadata",
      "chains a dynamic package import",
      "directly requires package metadata",
      "directly imports package metadata",
    ]);
  });

  it("preserves source references inside template interpolation", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import { expect, it } from "vitest";

      it("formats a raw config field", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        expect(\`package=\${raw.name}\`).toBe("package=nemoclaw");
      });

      it("keeps interpolation after comment and regex braces", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        expect(\`package=\${/* } */ /}/.test("}") ? raw.name : ""}\`).toBe("package=nemoclaw");
      });

      it("ignores a variable name in template text", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        expect(\`the word raw is not an interpolation\`).toBe("the word raw is not an interpolation");
      });
    `);

    expect(cases).toEqual([
      "formats a raw config field",
      "keeps interpolation after comment and regex braces",
    ]);
  });

  it("detects declarative imports including Vitest config", () => {
    const cases = detectedCaseNames(`
      import target from "../test/e2e/targets/cloud.json";
      import vitestConfig from "../vitest.config";
      import { expect, it } from "vitest";

      it("mirrors imported target keys", () => expect(target.requiredSecrets).toEqual(["NVIDIA_API_KEY"]));
      it("mirrors project names", () => expect(vitestConfig.test.projects).toEqual(["cli", "integration"]));
    `);

    expect(cases).toEqual(["mirrors imported target keys", "mirrors project names"]);
  });

  it("keeps true fixtures and E2E executable source out of declarative findings", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import YAML from "yaml";
      import { expect, it } from "vitest";

      it("checks a fixture", () => {
        const config = YAML.parse(readFileSync("test/fixtures/config.yaml", "utf8")); expect(config.mode).toBe("fixture");
      });

      it("checks E2E source", () => {
        const source = readFileSync("test/e2e/live/example.test.ts", "utf8"); expect(source).toContain("runLiveProbe");
      });
    `);

    expect(cases).toEqual([]);
  });

  it("exempts only values rooted in production consumers", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import YAML from "yaml";
      import { expect, it } from "vitest";
      import { validateBlueprint } from "../src/lib/config-validator";

      it("asserts validator behavior", () => {
        const raw = YAML.parse(readFileSync("nemoclaw-blueprint/blueprint.yaml", "utf8"));
        const result = validateBlueprint(raw);
        expect(result.ok).toBe(true);
        expect(validateBlueprint(raw).errors).toEqual([]);
      });

      it("still catches nested raw shape", () => {
        const raw = YAML.parse(readFileSync("nemoclaw-blueprint/blueprint.yaml", "utf8"));
        const combined = { raw, checked: validateBlueprint(raw) };
        expect(combined.raw.components).toHaveProperty("sandbox");
      });
    `);

    expect(cases).toEqual(["still catches nested raw shape"]);
  });

  it("detects explicit raw-config accessors and local selectors", () => {
    const cases = detectedCaseNames(`
      import { expect, it } from "vitest";
      import { readWorkflow } from "./helpers/e2e-workflow-contract";
      import { listTargets } from "./e2e/registry/registry";

      it("mirrors workflow jobs through a selector", () => {
        const workflow = readWorkflow();
        function sortedJobNames() { return jobNames().sort(); }
        function jobNames() { return Object.keys(workflow.jobs); }
        expect(sortedJobNames()).toEqual(["build", "test"]);
      });

      it("mirrors registry targets directly", () =>
        expect(listTargets().map((target) => target.id)).toEqual(["local", "cloud"]));

      it("detects a selector that wraps an accessor", () => {
        function targetIds() { return listTargets().map((target) => target.id); }
        expect(targetIds()).toEqual(["local", "cloud"]);
      });

      it("detects an accessor element alias", () => {
        const first = listTargets()[0]; expect(first.id).toBe("local");
      });

      it("detects a nested accessor initializer", () => {
        const jobs = Object.keys(readWorkflow().jobs); expect(jobs).toEqual(["test", "build"]);
      });

      it("detects destructured raw config", () => {
        const { jobs } = readWorkflow(); expect(Object.keys(jobs)).toEqual(["test", "build"]);
      });

      it("detects an accumulator fed by registry entries", () => {
        const ids = [];
        for (const target of listTargets()) ids.push(target.id);
        expect(ids).toEqual(["local", "cloud"]);
      });

      it("detects an assignment accumulator", () => {
        let selected; selected = listTargets()[0]; expect(selected.id).toBe("local");
      });

      it("only checks the helper binding", () => expect(readWorkflow).toBeTypeOf("function"));
    `);

    expect(cases).toEqual([
      "mirrors workflow jobs through a selector",
      "mirrors registry targets directly",
      "detects a selector that wraps an accessor",
      "detects an accessor element alias",
      "detects a nested accessor initializer",
      "detects destructured raw config",
      "detects an accumulator fed by registry entries",
      "detects an assignment accumulator",
    ]);
  });

  it("tracks namespace accessors but not derived registry and manifest helpers", () => {
    const cases = detectedCaseNames(`
      import { expect, it } from "vitest";
      import * as workflows from "./helpers/e2e-workflow-contract";
      import * as registry from "./e2e/registry/registry";
      import { probesForState } from "./e2e/registry/expected-states";
      import { loadManifest, loadManifestsFromDir } from "./e2e/registry/manifests";

      it("mirrors a namespace-loaded workflow", () => {
        expect(Object.keys(workflows.readWorkflow().jobs)).toEqual(["test", "build"]);
        expect(registry.listTargets().map((target) => target.id)).toEqual(["local", "cloud"]);
      });

      it("asserts derived helper behavior", () => {
        const fixture = workflows.readYaml("test/fixtures/workflow.yaml"); expect(fixture.name).toBe("fixture");
        expect(probesForState({ probes: ["ready"] })).toEqual(["ready"]);
        expect(loadManifest("test/fixtures/target.yaml").valid).toBe(true);
        expect(loadManifestsFromDir("test/fixtures")).toHaveLength(1);
      });
    `);

    expect(cases).toEqual(["mirrors a namespace-loaded workflow"]);
  });

  it("does not taint spawn results when raw config feeds the command", () => {
    const cases = detectedCaseNames(`
      import { spawnSync } from "node:child_process";
      import { expect, it } from "vitest";
      import { readWorkflow } from "./helpers/e2e-workflow-contract";

      it("asserts executed behavior", () => {
        const workflow = readWorkflow();
        const result = spawnSync("workflow-check", [workflow.name], { encoding: "utf8" });
        expect(result.stdout).toContain(workflow.name);
      });
    `);

    expect(cases).toEqual([]);
  });

  it("does not taint execution of a program extracted from config", () => {
    const cases = detectedCaseNames(`
      import { expect, it } from "vitest";
      import { readWorkflow } from "./helpers/e2e-workflow-contract";

      const DynamicFunction = Object.getPrototypeOf(async () => undefined).constructor;
      const workflow = readWorkflow();
      const script = workflow.jobs.test.steps[0].with.script;
      async function runScript() {
        await new DynamicFunction("input", script)("fixture");
      }

      it("asserts executed workflow behavior", async () => {
        await expect(runScript()).resolves.toBeUndefined();
      });
    `);

    expect(cases).toEqual([]);
  });

  it("does not treat an AsyncFunction property name as execution", () => {
    const cases = detectedCaseNames(`
      import { readFileSync } from "node:fs";
      import { expect, it } from "vitest";

      it("keeps raw data tainted", () => {
        const raw = JSON.parse(readFileSync("package.json", "utf8"));
        const shape = { AsyncFunction: true, scripts: raw.scripts };
        expect(shape.scripts).toHaveProperty("test");
      });
    `);

    expect(cases).toEqual(["keeps raw data tainted"]);
  });

  it("scopes a valid contract exception to the immediately following finding", () => {
    const report = scanTextForTestReport(
      "test/virtual-source-shape.test.ts",
      `
      import { readFileSync } from "node:fs";
      import YAML from "yaml";
      import { expect, it } from "vitest";

      // source-shape-contract: security -- Cross-field digest equality protects the shipped trust anchor
      it("protects an integrity anchor", () => {
        const config = YAML.parse(readFileSync("nemoclaw-blueprint/blueprint.yaml", "utf8"));
        expect(config.digest).toBe(config.components.sandbox.digest);
      });

      it("still detects the next mirror", () => {
        const config = YAML.parse(readFileSync("nemoclaw-blueprint/blueprint.yaml", "utf8"));
        expect(config.components).toHaveProperty("sandbox");
      });
    `,
    );

    expect(report.contractExceptions.map((entry) => entry.name)).toEqual([
      "protects an integrity anchor",
    ]);
    expect(report.cases.map((entry) => entry.name)).toEqual(["still detects the next mirror"]);
    expect(report.invalidContractExceptions).toEqual([]);
    expect(sourceShapeSummary(report)).toMatchObject({
      source_shape_contract_exceptions: 1,
      source_shape_invalid_contract_exceptions: 0,
    });
  });

  it("recognizes contract annotations after template literals", () => {
    const report = scanTextForTestReport(
      "test/virtual-source-shape.test.ts",
      `
      import { readFileSync } from "node:fs";
      import YAML from "yaml";
      import { expect, it } from "vitest";

      const fixture = \`template literal before the annotation\`;

      // source-shape-contract: compatibility -- Exact legacy keys preserve the supported serialized interface
      it("protects a serialized compatibility contract", () => {
        const config = YAML.parse(readFileSync("nemoclaw-blueprint/blueprint.yaml", "utf8"));
        expect(config.legacyKey).toBe(fixture);
      });
    `,
    );

    expect(report.contractExceptions.map((entry) => entry.name)).toEqual([
      "protects a serialized compatibility contract",
    ]);
    expect(report.cases).toEqual([]);
    expect(report.invalidContractExceptions).toEqual([]);
  });

  it("rejects unsupported, short, and misplaced contract exceptions", () => {
    const source = (annotation: string, separator = "") => `
      import { readFileSync } from "node:fs";
      import { expect, it } from "vitest";

      ${annotation}
      ${separator}
      it("mirrors a workflow", () => {
        const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
        expect(workflow).toContain("pull_request:");
      });
    `;

    for (const [annotation, separator, reason] of [
      [
        "// source-shape-contract: snapshot -- This reason is sufficiently detailed",
        "",
        "unsupported category",
      ],
      ["// source-shape-contract: security -- Trust anchor", "", "reason is too short"],
      [
        "// source-shape-contract: security -- This reason is sufficiently detailed",
        "// not adjacent",
        "immediately above",
      ],
    ]) {
      const report = scanTextForTestReport(
        "test/virtual-source-shape.test.ts",
        source(annotation ?? "", separator),
      );
      expect(report.invalidContractExceptions[0]?.reason).toContain(reason);
      expect(report.cases).toHaveLength(1);
      expect(sourceShapeSummary(report).source_shape_invalid_contract_exceptions).toBe(1);
    }
  });

  it("rejects replacing an allowlisted exception with a same-count exception", () => {
    const allowed = [
      { file: "test/integrity.test.ts", test: "protects digest", category: "security" as const },
    ];
    expect(
      contractExceptionAllowlistErrors(
        [{ file: "test/integrity.test.ts", name: "protects digest", category: "security" }],
        allowed,
      ),
    ).toEqual([]);

    const errors = contractExceptionAllowlistErrors(
      [{ file: "test/integrity.test.ts", name: "mirrors keys", category: "security" }],
      allowed,
    );
    expect(errors).toEqual([
      expect.stringContaining("unapproved source-shape exception"),
      expect.stringContaining("unused source-shape exception allowance"),
    ]);

    expect(
      contractExceptionAllowlistErrors(
        [
          { file: "test/integrity.test.ts", name: "protects digest", category: "security" },
          { file: "test/integrity.test.ts", name: "protects digest", category: "security" },
        ],
        allowed,
      ),
    ).toEqual([expect.stringContaining("duplicate source-shape exception identity")]);
  });
});
