// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isMockParityRelevantSourceChange,
  type MockParityManifest,
  validateMockParity,
} from "../scripts/checks/e2e-mock-parity";
import { type CompositeAction, readYaml } from "./helpers/e2e-workflow-contract";

const live = "test/e2e/live/example.test.ts";
const fast = "test/e2e/support/example.test.ts";
const TAGGED_NEW_SOURCE = "// @module-tag e2e/credential-free\n";
const exists = (file: string) => file === live || file === fast;

function manifest(entries: MockParityManifest["entries"]): MockParityManifest {
  return { version: 1, entries };
}

describe("changed live E2E mock parity", () => {
  it("treats module-tag-only diffs as metadata", () => {
    expect(
      isMockParityRelevantSourceChange(
        "// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n",
        "// SPDX-License-Identifier: Apache-2.0\n// @module-tag e2e/credential-free\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        `${"// @module"}-tag retired/value\n\nexport {};\n`,
        "// @module-tag e2e/credential-free\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        "// old terminology\nexport {};\n",
        "// current terminology\nexport {};\n",
      ),
    ).toBe(false);
    expect(
      isMockParityRelevantSourceChange(
        "// @module-tag e2e/credential-free\n\nexport {};\n",
        "// @module-tag e2e/credential-free\n\nexport const changed = true;\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "export const fixture = `before\nafter`;\n",
        "export const fixture = `before\n// @module-tag e2e/credential-free\nafter`;\n",
      ),
    ).toBe(true);
    expect(
      isMockParityRelevantSourceChange(
        "// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n",
        "// SPDX-License-Identifier: Apache-2.0\n/* @module-tag e2e/credential-free */\n\nexport {};\n",
      ),
    ).toBe(false);
    expect(isMockParityRelevantSourceChange(null, null)).toBe(true);
    expect(isMockParityRelevantSourceChange(null, TAGGED_NEW_SOURCE)).toBe(true);
  });

  it("accepts a changed live E2E mapped to a fast PR test", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: [fast] }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("rejects a changed live E2E without a parity decision", () => {
    expect(
      validateMockParity({ manifest: manifest([]), changedFiles: [live], fileExists: exists }),
    ).toEqual([`${live}: changed live E2E needs an entry in test/e2e/mock-parity.json`]);
  });

  it("rejects mappings to missing or non-PR tests", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, fast: ["test/e2e/live/not-fast.test.ts", fast] }]),
        changedFiles: [live],
        fileExists: (file) => file === live,
      }),
    ).toEqual([
      `${live}: mapped fast test does not exist: ${fast}`,
      `${live}: test/e2e/live/not-fast.test.ts is not collected by a fast PR test project`,
    ]);
  });

  it("accepts an explicit decision for behavior that cannot be mocked", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveOnlyReason: "Requires public TLS and provider auth" }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([]);
  });

  it("reports a non-string live-only reason as a validation error", () => {
    expect(
      validateMockParity({
        manifest: manifest([{ live, liveOnlyReason: 42 as unknown as string }]),
        changedFiles: [live],
        fileExists: exists,
      }),
    ).toEqual([`${live}: liveOnlyReason must be a string`]);
  });
});

describe("trusted E2E parity entrypoint selection", () => {
  const action = readYaml<CompositeAction>(".github/actions/ci-cli-coverage-shard/action.yaml");
  const parityStep = action.runs.steps.find(
    (step) => step.name === "Validate changed live E2E mock parity",
  );
  const parityRun = parityStep?.run ?? "";
  const parityEnv = parityStep?.env ?? {};
  const stem = "scripts/checks/e2e-mock-parity";

  function withParityEntrypoints(
    extensions: readonly string[],
    verify: (result: SpawnSyncReturns<string>, commandLog: string) => void,
  ): void {
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-e2e-parity-entrypoint-"));
    const fakeBin = join(temp, "bin");
    const commandLog = join(temp, "command.json");
    mkdirSync(fakeBin);
    mkdirSync(join(temp, "scripts", "checks"), { recursive: true });
    writeFileSync(
      join(fakeBin, "npx"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.appendFileSync(process.env.COMMAND_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      ].join("\n"),
      { mode: 0o755 },
    );
    for (const extension of extensions) {
      writeFileSync(join(temp, `${stem}.${extension}`), "// fixture\n");
    }

    try {
      verify(
        spawnSync("bash", ["-c", parityRun], {
          cwd: temp,
          encoding: "utf8",
          env: {
            ...process.env,
            ...parityEnv,
            COMMAND_LOG: commandLog,
            EVENT_NAME: "pull_request",
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            PUSH_BASE_SHA: "unused",
          },
          timeout: 5_000,
        }),
        commandLog,
      );
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  }

  it.each([
    {
      extensions: ["mts", "ts"],
      expected: `${stem}.mts`,
      title: "prefers .mts when both entrypoints exist",
    },
    { extensions: ["mts"], expected: `${stem}.mts`, title: "runs the migrated .mts entrypoint" },
    { extensions: ["ts"], expected: `${stem}.ts`, title: "falls back to the .ts entrypoint" },
  ])("$title (#6921)", ({ extensions, expected }) => {
    withParityEntrypoints(extensions, (result, commandLog) => {
      expect(result.status, String(result.stderr)).toBe(0);
      expect(
        readFileSync(commandLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([["tsx", expected, "--base", "HEAD^1", "--head", "HEAD^2"]]);
    });
  });

  it("rejects a missing parity entrypoint (#6921)", () => {
    withParityEntrypoints([], (result, commandLog) => {
      expect(result.status, String(result.stderr)).toBe(1);
      expect(existsSync(commandLog)).toBe(false);
      expect(String(result.stdout)).toContain("Missing E2E mock parity entrypoint");
    });
  });
});
