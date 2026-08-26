// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildSyntheticModel,
  semanticReadback,
  slideModelSchemaPath,
} from "../../helpers/nemoclaw-product-slides-fixture";

const SCRIPT_DIRECTORY = path.resolve(".agents/skills/nemoclaw-maintainer-product-slides/scripts");
const MANAGED_ROLES = [
  "roadmap-executive",
  "roadmap-capability",
  "markitecture",
  "weekly-release",
] as const;

type SerializedFixture = {
  model: string;
  schema: string;
  googleReadback: string;
  pptxReadback: string;
  roleMap: string;
};

type FixturePaths = {
  model: string;
  schema: string;
  googleReadback: string;
  pptxReadback: string;
  roleMap: string;
};

type CliCase = {
  name: string;
  scriptName: string;
  resultKey: "equal" | "valid";
  args: (fixture: FixturePaths) => string[];
};

const OUTPUT_CLIS: CliCase[] = [
  {
    name: "slide model validation",
    scriptName: "validate-slide-model.mts",
    resultKey: "valid",
    args: (fixture) => ["--model", fixture.model, "--schema", fixture.schema, "--mode", "preview"],
  },
  {
    name: "cross-format parity",
    scriptName: "compare-output-parity.mts",
    resultKey: "equal",
    args: (fixture) => [
      "--model",
      fixture.model,
      "--google-readback",
      fixture.googleReadback,
      "--pptx-readback",
      fixture.pptxReadback,
      "--role-map",
      fixture.roleMap,
    ],
  },
];

let serializedFixture: SerializedFixture;

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-evidence-output-"));
}

function writeFixture(directoryPath: string): FixturePaths {
  const fixturePaths: FixturePaths = {
    model: path.join(directoryPath, "model.json"),
    schema: path.join(directoryPath, "schema.json"),
    googleReadback: path.join(directoryPath, "google-readback.json"),
    pptxReadback: path.join(directoryPath, "pptx-readback.json"),
    roleMap: path.join(directoryPath, "role-map.json"),
  };
  for (const key of Object.keys(fixturePaths) as Array<keyof FixturePaths>) {
    fs.writeFileSync(fixturePaths[key], serializedFixture[key], { mode: 0o600 });
  }
  return fixturePaths;
}

function runCli(testCase: CliCase, fixture: FixturePaths, outputPath?: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(SCRIPT_DIRECTORY, testCase.scriptName),
      ...testCase.args(fixture),
      ...(outputPath ? ["--output", outputPath] : []),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
}

function stagingEntries(directoryPath: string, outputPath: string): string[] {
  const prefix = `.${path.basename(outputPath)}.nemoclaw-stage-`;
  return fs.readdirSync(directoryPath).filter((entry) => entry.startsWith(prefix));
}

beforeAll(() => {
  const model = buildSyntheticModel();
  const readback = semanticReadback(model);
  serializedFixture = {
    model: JSON.stringify(model),
    schema: fs.readFileSync(slideModelSchemaPath, "utf8"),
    googleReadback: JSON.stringify(readback),
    pptxReadback: JSON.stringify(readback),
    roleMap: JSON.stringify({
      schemaVersion: 1,
      templateFingerprint: model.templateFingerprint,
      roles: Object.fromEntries(MANAGED_ROLES.map((role) => [role, {}])),
    }),
  };
});

describe.skipIf(process.platform === "win32")(
  "protected validation and parity evidence CLI outputs",
  () => {
    it.each(OUTPUT_CLIS)(
      "preserves $name JSON on stdout when no output path is supplied",
      (testCase) => {
        const directoryPath = temporaryDirectory();
        try {
          const fixture = writeFixture(directoryPath);

          const result = runCli(testCase, fixture);

          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toMatchObject({ [testCase.resultKey]: true });
        } finally {
          fs.rmSync(directoryPath, { recursive: true, force: true });
        }
      },
    );

    it.each(OUTPUT_CLIS)("does not replace a pre-existing $name target", (testCase) => {
      const directoryPath = temporaryDirectory();
      const outputParentPath = path.join(directoryPath, "output");
      const outputPath = path.join(outputParentPath, "evidence.json");
      try {
        const fixture = writeFixture(directoryPath);
        fs.mkdirSync(outputParentPath, { mode: 0o700 });
        fs.writeFileSync(outputPath, "existing evidence", { mode: 0o600 });

        const result = runCli(testCase, fixture, outputPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("output already exists and will not be overwritten");
        expect(fs.readFileSync(outputPath, "utf8")).toBe("existing evidence");
        expect(stagingEntries(outputParentPath, outputPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    });

    it.each(OUTPUT_CLIS)("does not follow a symbolic-link $name target", (testCase) => {
      const directoryPath = temporaryDirectory();
      const outputParentPath = path.join(directoryPath, "output");
      const referentPath = path.join(outputParentPath, "referent.json");
      const outputPath = path.join(outputParentPath, "evidence.json");
      try {
        const fixture = writeFixture(directoryPath);
        fs.mkdirSync(outputParentPath, { mode: 0o700 });
        fs.writeFileSync(referentPath, "referent evidence", { mode: 0o600 });
        fs.symlinkSync(referentPath, outputPath);

        const result = runCli(testCase, fixture, outputPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("output already exists and will not be overwritten");
        expect(fs.lstatSync(outputPath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(referentPath, "utf8")).toBe("referent evidence");
        expect(stagingEntries(outputParentPath, outputPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    });

    it.each(OUTPUT_CLIS)("rejects a symbolic-link $name output parent", (testCase) => {
      const directoryPath = temporaryDirectory();
      const realParentPath = path.join(directoryPath, "real-output");
      const aliasParentPath = path.join(directoryPath, "alias-output");
      const outputPath = path.join(aliasParentPath, "evidence.json");
      try {
        const fixture = writeFixture(directoryPath);
        fs.mkdirSync(realParentPath, { mode: 0o700 });
        fs.symlinkSync(realParentPath, aliasParentPath);

        const result = runCli(testCase, fixture, outputPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("contains an untrusted symbolic-link path");
        expect(fs.readdirSync(realParentPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    });

    it.each(OUTPUT_CLIS)("rejects a $name output parent that is not owner-only", (testCase) => {
      const directoryPath = temporaryDirectory();
      const outputParentPath = path.join(directoryPath, "shared-output");
      const outputPath = path.join(outputParentPath, "evidence.json");
      try {
        const fixture = writeFixture(directoryPath);
        fs.mkdirSync(outputParentPath, { mode: 0o750 });
        fs.chmodSync(outputParentPath, 0o750);

        const result = runCli(testCase, fixture, outputPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/must be owned by effective UID .* with mode 0700/u);
        expect(fs.existsSync(outputPath)).toBe(false);
        expect(stagingEntries(outputParentPath, outputPath)).toEqual([]);
      } finally {
        fs.chmodSync(outputParentPath, 0o700);
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    });

    it.each(OUTPUT_CLIS)("does not create a missing $name output parent", (testCase) => {
      const directoryPath = temporaryDirectory();
      const outputParentPath = path.join(directoryPath, "missing-output");
      const outputPath = path.join(outputParentPath, "evidence.json");
      try {
        const fixture = writeFixture(directoryPath);

        const result = runCli(testCase, fixture, outputPath);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Could not resolve protected output directory");
        expect(fs.existsSync(outputParentPath)).toBe(false);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    });

    it.each(OUTPUT_CLIS)("publishes mode-0600 $name JSON without staging files", (testCase) => {
      const directoryPath = temporaryDirectory();
      const outputParentPath = path.join(directoryPath, "output");
      const outputPath = path.join(outputParentPath, "evidence.json");
      try {
        const fixture = writeFixture(directoryPath);
        fs.mkdirSync(outputParentPath, { mode: 0o700 });

        const result = runCli(testCase, fixture, outputPath);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe("");
        expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toMatchObject({
          [testCase.resultKey]: true,
        });
        expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
        expect(stagingEntries(outputParentPath, outputPath)).toEqual([]);
      } finally {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    });
  },
);
