// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  REBUILD_HERMES_OLD_BASE_FIXTURE,
  verifyRebuildHermesOldBaseFixture,
} from "../live/rebuild-hermes-old-base-fixture.ts";
import { buildRebuildHermesOldSandboxDockerfile } from "../live/rebuild-hermes-old-sandbox.ts";

const fixture = REBUILD_HERMES_OLD_BASE_FIXTURE;
const validLabels = JSON.stringify({
  "org.opencontainers.image.version": fixture.release,
  "org.opencontainers.image.revision": fixture.revision,
  "org.opencontainers.image.source": fixture.source,
});
const validVersion = `Hermes Agent v${fixture.hermesSemver} (${fixture.hermesCalver})`;

describe("rebuild-Hermes historical base fixture", () => {
  it("seeds kanban with the historical CLI before OpenShell isolation (#7144)", () => {
    const dockerfile = buildRebuildHermesOldSandboxDockerfile({
      baseTag: "nemoclaw-hermes-old-base:test",
      baseResolutionMetadata: null,
      discordPlaceholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      kanbanTaskTitle: "NEMOCLAW_REBUILD_KANBAN_TEST",
    });

    expect(dockerfile).toContain("FROM nemoclaw-hermes-old-base:test");
    expect(dockerfile).toContain("RUN /usr/local/bin/hermes kanban init \\");
    expect(dockerfile).toContain(
      "&& /usr/local/bin/hermes kanban create 'NEMOCLAW_REBUILD_KANBAN_TEST' --initial-status blocked --json",
    );
    expect(dockerfile).toContain("&& test -s /sandbox/.hermes/kanban.db");
    expect(dockerfile.indexOf("hermes kanban init")).toBeLessThan(
      dockerfile.indexOf('CMD ["/bin/bash"]'),
    );
    expect(dockerfile).not.toContain("openshell sandbox exec");
  });

  it("accepts the exact immutable fixture and published provenance (#7144)", () => {
    expect(verifyRebuildHermesOldBaseFixture(fixture.imageRef, validLabels, validVersion)).toEqual({
      imageRef: fixture.imageRef,
      release: fixture.release,
      revision: fixture.revision,
      source: fixture.source,
      hermesVersion: validVersion,
    });
  });

  it.each([
    "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:v0.0.80",
    `ghcr.io/other/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
    `${fixture.imageRef.slice(0, -1)}0`,
  ])("rejects a mutable or unreviewed fixture reference %s (#7144)", (imageRef) => {
    expect(() => verifyRebuildHermesOldBaseFixture(imageRef, validLabels, validVersion)).toThrow(
      "reviewed immutable image digest",
    );
  });

  it.each([
    ["org.opencontainers.image.version", "v0.0.49"],
    ["org.opencontainers.image.revision", "0".repeat(40)],
    ["org.opencontainers.image.source", "https://example.invalid/NemoClaw"],
  ])("rejects mismatched fixture label %s (#7144)", (name, value) => {
    const labels = JSON.stringify({
      ...JSON.parse(validLabels),
      [name]: value,
    });

    expect(() => verifyRebuildHermesOldBaseFixture(fixture.imageRef, labels, validVersion)).toThrow(
      `OCI label '${name}'`,
    );
  });

  it("rejects malformed labels and the wrong Hermes runtime version (#7144)", () => {
    expect(() => verifyRebuildHermesOldBaseFixture(fixture.imageRef, "[]", validVersion)).toThrow(
      "OCI labels were not valid JSON",
    );
    expect(() =>
      verifyRebuildHermesOldBaseFixture(
        fixture.imageRef,
        validLabels,
        "Hermes Agent v0.14.0 (2026.5.16)",
      ),
    ).toThrow("runtime did not report");
  });
});
