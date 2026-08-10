// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, "..", "bin", "nemoclaw.js");
const HERMES_CLI = path.join(TEST_DIR, "..", "bin", "nemohermes.js");
const DEEPAGENTS_ALIAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-deepagents-update-bin-"));
const DEEPAGENTS_CLI = path.join(DEEPAGENTS_ALIAS_DIR, "nemo-deepagents");
fs.symlinkSync(CLI, DEEPAGENTS_CLI);

// oclif wraps the USAGE line to the terminal width, so a usage assertion that
// depends on where the break lands is environment-dependent. Compare against
// whitespace-collapsed help output instead.
const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ");

afterAll(() => {
  fs.rmSync(DEEPAGENTS_ALIAS_DIR, { force: true, recursive: true });
});

describe("nemoclaw update command", () => {
  it("appears in root help as an Upgrade command", () => {
    const output = execSync(`node "${CLI}" help`, { encoding: "utf-8" });
    expect(output).toContain("Upgrade");
    expect(output).toMatch(
      /nemoclaw update\s+Run the maintained NemoClaw installer update flow\s+\(--check, --fresh, --allow-downgrade, --yes\|-y\)/,
    );
  });

  it("prints oclif help for update-specific flags", () => {
    const output = execSync(`node "${CLI}" update --help`, { encoding: "utf-8" });
    expect(collapseWhitespace(output)).toContain(
      "update [--check] [--fresh] [--allow-downgrade] [--yes|-y]",
    );
    expect(output).toContain("--check");
    expect(output).toContain("--yes");
  });

  it("renders NemoHermes command names and product copy for the Hermes alias", () => {
    const rootHelp = execSync(`node "${HERMES_CLI}" help`, { encoding: "utf-8" });
    expect(rootHelp).toMatch(
      /nemohermes update\s+Run the maintained NemoHermes installer update flow\s+\(--check, --fresh, --allow-downgrade, --yes\|-y\)/,
    );

    const updateHelp = execSync(`node "${HERMES_CLI}" update --help`, { encoding: "utf-8" });
    expect(collapseWhitespace(updateHelp)).toContain(
      "$ nemohermes update [--check] [--fresh] [--allow-downgrade] [--yes|-y]",
    );
    expect(updateHelp).toContain("Run the maintained NemoHermes installer update flow");
    expect(updateHelp).toContain("Check for a NemoHermes CLI update");
    expect(updateHelp).not.toContain("NemoClaw CLI update");
  });

  it("renders NemoDeepAgents command names and product copy for the Deep Agents alias", () => {
    const rootHelp = execSync(`"${DEEPAGENTS_CLI}" help`, { encoding: "utf-8" });
    expect(rootHelp).toMatch(
      /nemo-deepagents update\s+Run the maintained NemoDeepAgents installer update flow\s+\(--check, --fresh, --allow-downgrade, --yes\|-y\)/,
    );

    const updateHelp = execSync(`"${DEEPAGENTS_CLI}" update --help`, {
      encoding: "utf-8",
    });
    expect(collapseWhitespace(updateHelp)).toContain(
      "$ nemo-deepagents update [--check] [--fresh] [--allow-downgrade] [--yes|-y]",
    );
    expect(updateHelp).toContain("Run the maintained NemoDeepAgents installer update flow");
    expect(updateHelp).toContain("Check for a NemoDeepAgents CLI update");
    expect(updateHelp).not.toContain("NemoClaw CLI update");
  });
});
