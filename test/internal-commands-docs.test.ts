// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation gate for the hidden `internal:*` command family (#3782).
 *
 * The `internal:*` commands are marked `hidden = true` in their oclif command
 * classes, so they are intentionally omitted from `nemoclaw --help`, from the
 * canonical `--dump-commands` list, and therefore from the `### \`nemoclaw …\``
 * parity check in check-docs.sh. That kept them "documented nowhere, but
 * trivially reachable": registered, routable, and explained only in the
 * developer-facing src/commands/internal/README.md.
 *
 * This test pins the user-facing references instead: every registered hidden
 * `internal:*` command must be listed in docs/reference/commands.mdx (by its
 * space-form invocation), while staying out of the public `### \`nemoclaw …\``
 * headings so command-level parity keeps treating them as hidden. The same
 * assertions run against the generated NemoHermes reference
 * (docs/reference/commands-nemohermes.mdx, `nemohermes` binary form) so a
 * regression in scripts/sync-agent-variant-docs.ts cannot silently drop the
 * section from the agent variant.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getRegisteredOclifCommandsMetadata } from "../src/lib/cli/oclif-metadata";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** User-facing command references, one per agent CLI variant. */
const references = [
  {
    name: "commands.mdx",
    binary: "nemoclaw",
    text: readFileSync(path.join(repoRoot, "docs/reference/commands.mdx"), "utf8"),
  },
  {
    name: "commands-nemohermes.mdx",
    binary: "nemohermes",
    text: readFileSync(path.join(repoRoot, "docs/reference/commands-nemohermes.mdx"), "utf8"),
  },
];

/** Hidden `internal:*` command IDs from the generated oclif manifest. */
function hiddenInternalCommandIds(): string[] {
  return Object.entries(getRegisteredOclifCommandsMetadata())
    .filter(([id, meta]) => id.startsWith("internal:") && meta.hidden === true)
    .map(([id]) => id)
    .sort();
}

/** `internal:uninstall:plan` -> `<binary> internal uninstall plan`. */
function spaceFormInvocation(binary: string, commandId: string): string {
  return `${binary} ${commandId.replace(/:/g, " ")}`;
}

describe("internal command documentation (#3782)", () => {
  const internalIds = hiddenInternalCommandIds();

  it("registers the hidden internal command family", () => {
    // Guards against the manifest silently losing the family (which would make
    // the documentation assertions below vacuously pass).
    expect(internalIds.length).toBeGreaterThanOrEqual(9);
  });

  it.each(references)(
    "documents every hidden internal command in $name",
    ({ text, binary }) => {
      const undocumented = internalIds.filter(
        (id) => !text.includes(spaceFormInvocation(binary, id)),
      );
      expect(undocumented).toEqual([]);
    },
  );

  it.each(references)(
    "keeps internal commands out of the public command headings in $name",
    ({ text, binary }) => {
      // canonicalUsageList() (and thus check-docs.sh command-level parity) only
      // sees non-hidden commands, so an `### \`<binary> internal …\`` heading
      // would be flagged as docs-only drift. Internal commands must be listed
      // in some other form (a table, prose, fenced block) instead.
      const headingPrefix = `### \`${binary} internal`;
      const offendingHeadings = text
        .split("\n")
        .filter((line) => line.startsWith(headingPrefix));
      expect(offendingHeadings).toEqual([]);
    },
  );
});
