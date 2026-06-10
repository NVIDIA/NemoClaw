// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation gate for the Control UI config endpoint (#4778).
 *
 * QA followed a test case that curled `controlui.bootstrap.config.json` and
 * expected `HTTP 200` JSON. That path is not served by the gateway: it returns
 * `404 Not Found` with a plain-text body, so `jq` rejects it. The supported
 * endpoint is the auth-gated `/__openclaw/control-ui-config.json`, which the
 * gateway serves on the forwarded dashboard port.
 *
 * This test pins the user-facing references so the docs cannot drift back to
 * advertising the non-existent path: the troubleshooting page must document the
 * correct endpoint, the 404 symptom, and the `gateway-token`-authenticated
 * verification command, and the command reference must mention the supported
 * endpoint alongside `gateway-token`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

const SUPPORTED_ENDPOINT = "/__openclaw/control-ui-config.json";
const WRONG_PATH = "controlui.bootstrap.config.json";

const troubleshooting = readFileSync(
  path.join(repoRoot, "docs/reference/troubleshooting.mdx"),
  "utf8",
);
const commands = readFileSync(path.join(repoRoot, "docs/reference/commands.mdx"), "utf8");

describe("Control UI config endpoint documentation (#4778)", () => {
  it("documents the supported endpoint in the troubleshooting guide", () => {
    expect(troubleshooting).toContain(SUPPORTED_ENDPOINT);
  });

  it("documents the 404 symptom for the non-existent bootstrap path", () => {
    // The wrong path must be named so QA can map their symptom to the fix, and
    // it must be described as a 404 rather than advertised as a working path.
    expect(troubleshooting).toContain(WRONG_PATH);
    expect(troubleshooting).toMatch(/controlui\.bootstrap\.config\.json[\s\S]*404/);
  });

  it("documents the gateway-token-authenticated verification command", () => {
    expect(troubleshooting).toContain("gateway-token");
    expect(troubleshooting).toMatch(
      /Authorization: Bearer \$TOKEN[\s\S]*__openclaw\/control-ui-config\.json/,
    );
  });

  it("references the supported endpoint from the gateway-token command docs", () => {
    expect(commands).toContain(SUPPORTED_ENDPOINT);
    const tokenSection = commands.slice(commands.indexOf("gateway-token"));
    expect(tokenSection).toContain(SUPPORTED_ENDPOINT);
  });
});
