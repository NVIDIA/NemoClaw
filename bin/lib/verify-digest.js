// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Blueprint digest verification — computes a SHA-256 digest over the blueprint
// directory contents and compares it against the digest field in blueprint.yaml.
// Fails closed: missing or empty digest fields are treated as verification failures.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BLUEPRINT_DIR = path.join(__dirname, "..", "..", "nemoclaw-blueprint");
const BLUEPRINT_YAML = path.join(BLUEPRINT_DIR, "blueprint.yaml");

/**
 * Recursively collect all files in a directory, sorted for deterministic hashing.
 */
function collectFiles(dirPath, prefix = "") {
  const entries = fs.readdirSync(dirPath).sort();
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Compute a deterministic SHA-256 digest over all files in the blueprint directory.
 * The digest covers file paths and contents to detect any modification.
 * blueprint.yaml itself is included but the digest field is zeroed before hashing
 * to avoid a circular dependency.
 */
function computeBlueprintDigest() {
  const files = collectFiles(BLUEPRINT_DIR);
  const hash = crypto.createHash("sha256");

  for (const file of files) {
    hash.update(file);
    let content = fs.readFileSync(path.join(BLUEPRINT_DIR, file));
    // Zero the digest field in blueprint.yaml to avoid circular dependency
    if (file === "blueprint.yaml") {
      content = Buffer.from(
        content.toString("utf-8").replace(/^digest:\s*"[^"]*"/m, 'digest: ""')
      );
    }
    hash.update(content);
  }

  return hash.digest("hex");
}

/**
 * Extract the digest field from blueprint.yaml.
 */
function readExpectedDigest() {
  const content = fs.readFileSync(BLUEPRINT_YAML, "utf-8");
  const match = content.match(/^digest:\s*"([^"]*)"/m);
  return match ? match[1] : null;
}

/**
 * Verify the blueprint directory against its declared digest.
 *
 * @param {object} opts
 * @param {boolean} opts.skipVerification - If true, skip verification (explicit opt-out)
 * @returns {{ valid: boolean, reason?: string, expectedDigest: string|null, actualDigest: string }}
 */
function verifyBlueprintDigest(opts = {}) {
  if (opts.skipVerification) {
    return { valid: true, reason: "verification skipped (--skip-verification)", expectedDigest: null, actualDigest: "" };
  }

  const expectedDigest = readExpectedDigest();
  const actualDigest = computeBlueprintDigest();

  // Fail closed: missing or empty digest is a verification failure
  if (!expectedDigest || expectedDigest.trim() === "") {
    return {
      valid: false,
      reason: "digest field is missing or empty in blueprint.yaml — verification required",
      expectedDigest: expectedDigest || "",
      actualDigest,
    };
  }

  if (expectedDigest !== actualDigest) {
    return {
      valid: false,
      reason: `digest mismatch: expected ${expectedDigest}, got ${actualDigest}`,
      expectedDigest,
      actualDigest,
    };
  }

  return { valid: true, expectedDigest, actualDigest };
}

module.exports = { verifyBlueprintDigest, computeBlueprintDigest, readExpectedDigest };
