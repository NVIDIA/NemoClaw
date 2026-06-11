#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * NemoClaw compatibility shim for OpenClaw's `doctor` state-integrity check
 * (NVIDIA/NemoClaw #4538, #4859).
 *
 * OpenClaw's doctor enforces a single-user 700/600 state layout: it flags the
 * state directory and openclaw.json as "too open" whenever ANY group OR other
 * permission bit is set (`(stat.mode & 63) !== 0`, where 63 === 0o77), and with
 * `--fix` it tightens them to 700/600.
 *
 * NemoClaw's mutable-config contract is the opposite by design: the gateway runs
 * under a distinct UID that shares the `sandbox` group (Dockerfile.base
 * `usermod -aG sandbox gateway`), so /sandbox/.openclaw must stay setgid +
 * group-writable (2770) and openclaw.json group-writable (660) or the gateway
 * UID EACCESes on every control-UI config write. A raw in-sandbox
 * `openclaw doctor --fix` tightens 2770/660 back to 700/600, durably breaking
 * that contract (the regression QA reopened in #4538 and #4859), and prints
 * scary "permissions are too open" / "Tightened permissions ... to 700/600"
 * messages that misrepresent the intended contract as a misconfiguration.
 *
 * This patch narrows doctor's over-open test to OTHER (world) bits only when the
 * process runs inside an OpenShell sandbox (OPENSHELL_SANDBOX is set):
 *
 *     (stat.mode & 63) !== 0
 *   → (stat.mode & (process.env.OPENSHELL_SANDBOX ? 7 : 63)) !== 0
 *
 * where 7 === 0o7 (other-rwx). Group bits (the gateway's shared access) are then
 * tolerated, so the NemoClaw 2770/660 contract is neither flagged nor tightened,
 * while genuinely world-accessible modes (e.g. 0o2777 / 0o664) are still caught
 * and repaired. Out-of-sandbox behavior (no OPENSHELL_SANDBOX) is byte-identical
 * to upstream. OpenShell injects OPENSHELL_SANDBOX at sandbox runtime; an
 * image-level ENV does not survive (it is stripped by OpenShell), which is why
 * the bypass keys on the runtime env var rather than a build-time flag.
 *
 * NOTE on the gate: OpenShell injects the sandbox NAME into OPENSHELL_SANDBOX
 * (e.g. `OPENSHELL_SANDBOX=my-sandbox`), verified against OpenShell 0.0.44 — it
 * is NOT the literal "1". The bypass therefore keys on the var being non-empty
 * ("inside any OpenShell sandbox") rather than `=== "1"`, so it actually fires in
 * the sandbox runtime where the reporter runs `openclaw doctor`. The var is unset
 * outside an OpenShell sandbox, so upstream behavior is preserved there.
 *
 * The patch classifies the compiled OpenClaw dist by content signature, requires
 * exactly the two reviewed `(stat.mode & 63) !== 0` permission gates in the
 * doctor state-integrity module, and fails loudly when the shape is unrecognized
 * rather than silently leaving the sandbox unpatched. It is idempotent and a
 * no-op when no matching module is present.
 *
 * Removal criteria: drop when OpenClaw's doctor recognizes a group-shared state
 * layout (or exposes config to opt out of the 700/600 enforcement), so the
 * NemoClaw mutable contract is no longer reported and tightened.
 *
 * Usage: patch-openclaw-doctor-mutable-perms.mts <openclaw-dist-dir> [<dir>...]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const STATE_DIR_SIGNATURE = "State directory permissions are too open";
const CONFIG_SIGNATURE = "Config file is group/world readable";
const PERM_GATE = "(stat.mode & 63) !== 0";
const PATCHED_GATE = "(stat.mode & (process.env.OPENSHELL_SANDBOX ? 7 : 63)) !== 0";
const PATCH_MARKER = "nemoclaw: tolerate group-shared mutable config perms";
const EXPECTED_GATES = 2;

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("Usage: patch-openclaw-doctor-mutable-perms.mts <openclaw-dist-dir> [<dir>...]");
  process.exit(2);
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function listJsFiles(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(dir, entry.name));
}

// Locate the compiled doctor state-integrity module(s): the file owns both the
// state-dir and config-file permission warnings. The hashed filename drifts
// between bundles, so classify by content rather than by name.
function locateDoctorModules(searchDirs: string[]): string[] {
  const found = new Set<string>();
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const file of listJsFiles(dir)) {
      const source = readFileSync(file, "utf8");
      if (source.includes(STATE_DIR_SIGNATURE) && source.includes(CONFIG_SIGNATURE)) {
        found.add(file);
      }
    }
  }
  return [...found];
}

function patchDoctorModule(file: string): boolean {
  const source = readFileSync(file, "utf8");

  if (source.includes(PATCH_MARKER)) {
    // Already patched (idempotent re-run). Confirm no unpatched gate slipped
    // back in alongside the patched ones.
    if (source.includes(PERM_GATE)) {
      fail(
        `doctor state-integrity module ${file} is partially patched (found an unpatched ` +
          `'${PERM_GATE}' gate alongside the NemoClaw marker); inspect the dist and re-review this patch`,
      );
    }
    return false;
  }

  // Shape gate: both the over-open checks must be present in the reviewed
  // `(stat.mode & 63) !== 0` form. Anything else means OpenClaw reworked the
  // permission logic and the rewrite must be re-reviewed.
  const gateCount = source.split(PERM_GATE).length - 1;
  if (gateCount !== EXPECTED_GATES) {
    fail(
      `doctor state-integrity module ${file} has ${gateCount} '${PERM_GATE}' permission gates ` +
        `(expected exactly ${EXPECTED_GATES}); refusing ambiguous rewrite — re-review this patch for the new OpenClaw layout`,
    );
  }

  const patched = source.replaceAll(
    PERM_GATE,
    `${PATCHED_GATE} /* ${PATCH_MARKER} (#4538, #4859) */`,
  );

  const patchedCount = patched.split(PATCHED_GATE).length - 1;
  if (patchedCount !== EXPECTED_GATES) {
    fail(
      `doctor state-integrity patch verification failed for ${file}: expected ${EXPECTED_GATES} ` +
        `patched permission gates, found ${patchedCount}`,
    );
  }
  if (patched.includes(PERM_GATE)) {
    fail(`doctor state-integrity patch left an unpatched permission gate in ${file}`);
  }

  writeFileSync(file, patched);
  return true;
}

const modules = locateDoctorModules(dirs);
if (modules.length === 0) {
  console.log(
    `INFO: no OpenClaw doctor state-integrity module found under ${dirs.join(", ")}; ` +
      "skipping mutable-perms doctor patch",
  );
  process.exit(0);
}

const patchedFiles: string[] = [];
for (const file of modules) {
  const changed = patchDoctorModule(file);
  const verified = readFileSync(file, "utf8");
  if (!verified.includes(PATCH_MARKER)) {
    fail(`doctor mutable-perms patch did not apply in ${file}`);
  }
  if (changed) patchedFiles.push(file);
}

if (patchedFiles.length > 0) {
  console.log(
    `INFO: patched OpenClaw doctor mutable-perms gate in ${patchedFiles
      .map((file) => relative(process.cwd(), file))
      .join(", ")}`,
  );
} else {
  console.log("INFO: OpenClaw doctor mutable-perms patch already present; nothing to do");
}
