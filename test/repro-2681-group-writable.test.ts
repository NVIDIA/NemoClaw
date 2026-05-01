// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guards for the group-writable mutable-default contract (#2681).
 *
 * Before this PR, control-UI config mutations in the OpenClaw sandbox
 * (Enable Dreaming, account toggles, etc.) wrote through mutateConfigFile,
 * which targeted /sandbox/.openclaw/openclaw.json — owned sandbox:sandbox
 * mode 600. The gateway runs as a separate UID, so every mutation EACCES'd.
 *
 * The previous proposal (#2693) wrapped mutateConfigFile in a try/catch
 * that swallowed EACCES, making the mutation a silent no-op. That made
 * toggles non-functional in the sandbox.
 *
 * This PR replaces that approach with proper Unix group permissions:
 *   1. `gateway` is a member of the `sandbox` group (Dockerfile.base usermod).
 *   2. /sandbox/.openclaw is group-writable + setgid (chmod g+w + g+s).
 *   3. nemoclaw-start.sh normalizes those perms before gateway launch when
 *      shields are not UP.
 *   4. `shields down` restores 660/2770 instead of the old 600/700.
 *
 * Result: writes succeed in default mode without an EACCES swallow.
 *
 * These tests lock the structural invariants so a future change can't
 * silently regress to the swallow approach.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE_BASE = fs.readFileSync(path.join(ROOT, "Dockerfile.base"), "utf-8");
const DOCKERFILE = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
const NEMOCLAW_START = fs.readFileSync(
  path.join(ROOT, "scripts", "nemoclaw-start.sh"),
  "utf-8",
);
const SHIELDS_TS = fs.readFileSync(path.join(ROOT, "src", "lib", "shields.ts"), "utf-8");

describe("Issue #2681 — group-writable mutable-default contract", () => {
  it("Dockerfile.base adds gateway to the sandbox group", () => {
    expect(DOCKERFILE_BASE).toMatch(/usermod\s+-aG\s+sandbox\s+gateway/);
  });

  it("Dockerfile.base makes /sandbox/.openclaw group-writable + setgid", () => {
    expect(DOCKERFILE_BASE).toMatch(/chmod\s+-R\s+g\+w\s+\/sandbox\/\.openclaw/);
    expect(DOCKERFILE_BASE).toMatch(
      /find\s+\/sandbox\/\.openclaw\s+-type\s+d\s+-exec\s+chmod\s+g\+s/,
    );
  });

  it("Dockerfile has stale-base fallback that idempotently adds gateway to sandbox group", () => {
    // Older base images won't have the usermod yet; the derived image must
    // add it at build time so PR images work even before sandbox-base is
    // rebuilt.
    expect(DOCKERFILE).toMatch(/id\s+gateway/);
    expect(DOCKERFILE).toMatch(/usermod\s+-aG\s+sandbox\s+gateway/);
  });

  it("Dockerfile applies group-writable + setgid in the production image too", () => {
    expect(DOCKERFILE).toMatch(/chmod\s+-R\s+g\+w\s+\/sandbox\/\.openclaw/);
    expect(DOCKERFILE).toMatch(
      /find\s+\/sandbox\/\.openclaw\s+-type\s+d\s+-exec\s+chmod\s+g\+s/,
    );
  });

  it("Dockerfile creates .config-hash group-writable (664), not read-only-for-group (644)", () => {
    // Aaron's spec item 3 explicitly calls out "group-writable config/hash
    // files". The .config-hash sha256 is created AFTER the recursive chmod
    // g+w pass, so it gets its own explicit chmod. Lock it to 664 so a
    // future change can't silently revert to 644 and break gateway writes.
    expect(DOCKERFILE).toMatch(/chmod\s+664\s+\/sandbox\/\.openclaw\/\.config-hash/);
    expect(DOCKERFILE).not.toMatch(/chmod\s+644\s+\/sandbox\/\.openclaw\/\.config-hash/);
  });

  it("Dockerfile does NOT introduce a mutateConfigFile EACCES swallow patch", () => {
    // The PR explicitly replaces #2693's approach. If a future PR adds
    // Patch 4b back, this test fails and forces re-evaluation.
    expect(DOCKERFILE).not.toMatch(/Patch\s+4b/);
    expect(DOCKERFILE).not.toMatch(/mutateConfigFile.*EACCES/);
    expect(DOCKERFILE).not.toMatch(/mutation not persisted/);
  });

  it("nemoclaw-start.sh defines normalize_mutable_config_perms", () => {
    expect(NEMOCLAW_START).toMatch(/normalize_mutable_config_perms\s*\(\)/);
  });

  it("normalize_mutable_config_perms skips when shields are UP (root-owned config dir)", () => {
    // The function must check ownership before chmod-ing; if shields are
    // up the dir is root-owned and normalizing would weaken the lock.
    const fnIdx = NEMOCLAW_START.indexOf("normalize_mutable_config_perms()");
    expect(fnIdx).toBeGreaterThan(0);
    const fnBody = NEMOCLAW_START.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toMatch(/stat\s+-c\s+'%U'/);
    expect(fnBody).toMatch(/= "root"/);
  });

  it("normalize_mutable_config_perms is called in the root-mode startup path", () => {
    expect(NEMOCLAW_START).toMatch(/normalize_mutable_config_perms\b[^(]/);
  });

  it("shields.ts unlock path uses group-writable file mode (660) + setgid dir (2770) for openclaw", () => {
    // Pre-#2681 openclaw unlock used 600/700 which stripped group-write.
    // After this PR openclaw uses 660/2770 so the gateway UID (member of
    // sandbox group) can write OpenClaw config. Hermes is left unchanged
    // (no separate gateway UID, so the shared-group contract doesn't apply).
    expect(SHIELDS_TS).toMatch(/agentName === "hermes" \? "640" : "660"/);
    expect(SHIELDS_TS).toMatch(/agentName === "hermes" \? "750" : "2770"/);
  });

  it("applyStateDirLockMode re-adds group-write when unlocking (shields down)", () => {
    // The chmod in the unlock path must explicitly RE-ADD group-write,
    // not just preserve it. A prior `chmod -R go-w` from shields-up
    // already stripped g+w from descendants, so unlock must use `g+w,o-w`
    // to restore the group-writable contract on the whole tree.
    expect(SHIELDS_TS).toMatch(/isLocking\s*\?\s*"go-w"\s*:\s*"g\+w,o-w"/);
  });
});
