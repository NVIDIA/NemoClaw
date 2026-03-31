// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Mount management — read and write the mounts: section of the policy YAML.

const fs = require("fs");
const path = require("path");
const { ROOT } = require("./runner");

const POLICY_FILE = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");

/**
 * @typedef {{ host_path: string; container_path: string; read_only?: boolean }} MountEntry
 */

/**
 * Validate an absolute Unix path: must start with /, no null bytes, no .. components.
 * Returns the path unchanged on success; throws on failure.
 */
// Keep in sync with nemoclaw/src/blueprint/runner.ts:validateMountPath
function validateMountPath(p, label) {
  if (!p || typeof p !== "string") throw new Error(`${label} is required`);
  if (!p.startsWith("/")) throw new Error(`${label} must be an absolute path: ${p}`);
  if (p.includes("\0")) throw new Error(`${label} must not contain null bytes`);
  if (p.split("/").some((s) => s === "..")) {
    throw new Error(`${label} must not contain path traversal: ${p}`);
  }
  return p;
}

/**
 * Parse the mounts: section from raw policy YAML using a line-oriented state
 * machine. Returns an array of { host_path, container_path, read_only } objects.
 * Returns [] if the section is absent or empty.
 * @param {string} content
 * @returns {MountEntry[]}
 */
function parseMountsFromYaml(content) {
  /** @type {MountEntry[]} */
  const mounts = [];
  const lines = content.split("\n");
  let inMounts = false;
  /** @type {MountEntry | null} */
  let current = null;

  for (const line of lines) {
    // Top-level mounts: key (possibly with inline empty list)
    if (/^mounts\s*:/.test(line)) {
      inMounts = true;
      // Inline empty: mounts: [] — nothing to collect
      continue;
    }

    // Any non-indented, non-empty, non-comment line ends the section
    if (inMounts && line !== "" && /^\S/.test(line) && !line.startsWith("#")) {
      if (current) {
        mounts.push(current);
        current = null;
      }
      inMounts = false;
      continue;
    }

    if (!inMounts) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // New list item: "  - host_path: ..."
    if (/^\s+-\s+\w/.test(line)) {
      if (current) mounts.push(current);
      current = /** @type {MountEntry} */ ({});
      parseKv(trimmed.replace(/^-\s+/, ""), current);
      continue;
    }

    // Continuation key inside current item
    if (current && /^\s+\w/.test(line)) {
      parseKv(trimmed, current);
    }
  }

  if (current) mounts.push(current);

  return mounts.filter(
    (m) => typeof m.host_path === "string" && typeof m.container_path === "string",
  );
}

function parseKv(line, obj) {
  const m = line.match(/^([\w]+)\s*:\s*(.*)$/);
  if (!m) return;
  const key = m[1];
  const raw = m[2].trim();
  if (raw === "true") obj[key] = true;
  else if (raw === "false") obj[key] = false;
  else obj[key] = raw;
}

/**
 * Append a new mount entry to the mounts: section of the policy YAML in-place.
 * Returns true if written, false if the entry was already present.
 * Throws if the policy file does not exist.
 */
function addMountToPolicy(hostPath, containerPath, readOnly) {
  if (!fs.existsSync(POLICY_FILE)) {
    throw new Error(`Policy file not found: ${POLICY_FILE}`);
  }

  const content = fs.readFileSync(POLICY_FILE, "utf-8");
  const existing = parseMountsFromYaml(content);

  if (existing.some((m) => m.host_path === hostPath && m.container_path === containerPath)) {
    return false;
  }

  const roLine = readOnly ? "\n    read_only: true" : "";
  const newEntry = `  - host_path: ${hostPath}\n    container_path: ${containerPath}${roLine}`;

  const updated = insertMountEntry(content, newEntry);
  fs.writeFileSync(POLICY_FILE, updated, { encoding: "utf-8" });
  return true;
}

/**
 * Insert a new mount entry into raw policy YAML content.
 * Handles: empty mounts: [], existing list, and missing section.
 */
function insertMountEntry(content, newEntry) {
  const lines = content.split("\n");
  let mountsIdx = -1;
  let sectionEndIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^mounts\s*:/.test(lines[i])) {
      mountsIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l !== "" && /^\S/.test(l) && !l.startsWith("#")) {
          sectionEndIdx = j;
          break;
        }
      }
      break;
    }
  }

  if (mountsIdx === -1) {
    // No mounts section — append at end
    return content.trimEnd() + "\n\nmounts:\n" + newEntry + "\n";
  }

  const entryLines = newEntry.split("\n");

  // Replace inline empty: mounts: []
  if (/^mounts\s*:\s*\[\s*\]/.test(lines[mountsIdx])) {
    lines[mountsIdx] = "mounts:";
    lines.splice(mountsIdx + 1, 0, ...entryLines);
    return lines.join("\n");
  }

  // Insert before next top-level key, or at end of file
  const insertAt = sectionEndIdx === -1 ? lines.length : sectionEndIdx;
  lines.splice(insertAt, 0, ...entryLines);
  return lines.join("\n");
}

/**
 * Load the mounts declared in the shared policy YAML.
 * Returns [] if the policy file is missing or the section is empty.
 * @returns {MountEntry[]}
 */
function loadMountsFromPolicy() {
  if (!fs.existsSync(POLICY_FILE)) return [];
  return parseMountsFromYaml(fs.readFileSync(POLICY_FILE, "utf-8"));
}

module.exports = {
  POLICY_FILE,
  validateMountPath,
  parseMountsFromYaml,
  insertMountEntry,
  loadMountsFromPolicy,
  addMountToPolicy,
};
