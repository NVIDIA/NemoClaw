// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LIVE_TEST = path.join(REPO_ROOT, "test/e2e/live/issue-4462-scope-upgrade-approval.test.ts");

describe("scope-upgrade approval live fixture", () => {
  it("publishes the paired credential before clearing pending state", () => {
    const source = fs.readFileSync(LIVE_TEST, "utf8");
    const seedStart = source.indexOf("seed_initial_pairing_request() {");
    const seedEnd = source.indexOf("rotate_cli_to_pairing_scope() {", seedStart);
    const seed = source.slice(seedStart, seedEnd);

    const pairedReplace = seed.indexOf("os.replace(paired_tmp, paired_path)");
    const authReplace = seed.indexOf("os.replace(auth_tmp, auth_path)");
    const pendingReplace = seed.indexOf("os.replace(pending_tmp, pending_path)");

    expect(seedStart).toBeGreaterThanOrEqual(0);
    expect(seedEnd).toBeGreaterThan(seedStart);
    expect(pairedReplace).toBeGreaterThanOrEqual(0);
    expect(authReplace).toBeGreaterThan(pairedReplace);
    expect(pendingReplace).toBeGreaterThan(authReplace);
    expect(source).toContain("req.get('isRepair') is True");
    expect(source).toContain("request.get('isRepair') is not True");
    expect(seed).toContain("value.get('isRepair') is True");
    expect(seed).toContain("temporary pairing seed left an unsafe same-device request pending");
    expect(source).toContain("e.get('clientId') == 'cli' and e.get('clientMode') == 'cli'");
  });
});
