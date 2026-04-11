// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

const { ROOT, run, runCapture, shellQuote } = require("./runner");
const { parseGatewayInference } = require("./inference-config");
const registry = require("./registry");

const BACKUP_ROOT = path.join(process.env.HOME || os.tmpdir(), ".nemoclaw", "backups");
const ARCHIVE_FILE = "sandbox.tar.gz";
const MANIFEST_FILE = "backup-manifest.json";
const MANIFEST_VERSION = 1;
const REMOTE_ARCHIVE_PATH = "/tmp/nemoclaw-sandbox-backup.tar.gz";
const START_SCRIPT_PATH = "/usr/local/bin/nemoclaw-start";
const RESTORE_EXCLUDES = ["sandbox/.openclaw", "sandbox/.nemoclaw/blueprints"];
function getSandboxBackupRoot(sandboxName) {
  return path.join(BACKUP_ROOT, sandboxName);
}

function hasSandboxBackups(sandboxName) {
  const backupRoot = getSandboxBackupRoot(sandboxName);
  return (
    fs.existsSync(backupRoot) &&
    fs.readdirSync(backupRoot).some((entry) => {
      const fullPath = path.join(backupRoot, entry);
      try {
        return fs.statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    })
  );
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") +
    "-" +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("")
  );
}

function normalizeBackupId(label) {
  if (label == null) return null;
  const trimmed = String(label).trim();
  if (!trimmed) {
    throw new Error("Backup label cannot be empty.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error(
      "Backup label must start with a letter or number and use only letters, numbers, '.', '_' or '-'.",
    );
  }
  return trimmed;
}

function ensureSecureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort on platforms that ignore chmod.
  }
}

function readManifest(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function writeManifest(backupDir, manifest) {
  fs.writeFileSync(path.join(backupDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
}

function getArchivePath(backupDir, manifest = null) {
  const archiveName = manifest && manifest.archiveFile ? manifest.archiveFile : ARCHIVE_FILE;
  return path.join(backupDir, archiveName);
}

function getDirectorySizeBytes(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(fullPath);
      continue;
    }
    try {
      total += fs.statSync(fullPath).size;
    } catch {
      // Ignore disappearing files while listing backups.
    }
  }
  return total;
}

function getGatewayInferenceMetadata() {
  const output = runCapture("openshell inference get 2>/dev/null", { ignoreError: true });
  const parsed = parseGatewayInference(output);
  return {
    model: parsed && parsed.model ? parsed.model : null,
    provider: parsed && parsed.provider ? parsed.provider : null,
    providerBaseUrl: null,
  };
}

function buildManifest(sandboxName, options = {}) {
  const packageVersion = options.packageVersion || require(path.join(ROOT, "package.json")).version;
  const registryEntry = options.registryEntry ||
    registry.getSandbox(sandboxName) || { name: sandboxName };
  return {
    manifestVersion: MANIFEST_VERSION,
    backupType: "full-sandbox-filesystem",
    sandboxName,
    backupId: options.backupId || formatTimestamp(options.now),
    label: options.label || null,
    createdAt: (options.now || new Date()).toISOString(),
    archiveFile: ARCHIVE_FILE,
    nemoclawVersion: packageVersion,
    openshellVersion:
      options.openshellVersion ||
      runCapture("openshell --version 2>/dev/null", { ignoreError: true }) ||
      null,
    registry: {
      ...registryEntry,
      name: sandboxName,
    },
  };
}

function runSandboxScript(sandboxName, script, options = {}) {
  const finalScript = `${String(script || "").trimEnd()}\nexit`;
  const command = `cat <<'EOF_NEMOCLAW_SANDBOX_SCRIPT' | openshell sandbox connect ${shellQuote(sandboxName)}\n${finalScript}\nEOF_NEMOCLAW_SANDBOX_SCRIPT`;
  const result = run(command, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    ...options,
  });
  if (result.status !== 0 && !options.ignoreError) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || `Sandbox command failed while processing '${sandboxName}'.`);
  }
  return result;
}

function downloadFromSandbox(sandboxName, remotePath, localDir) {
  const result = run(
    `openshell sandbox download ${shellQuote(sandboxName)} ${shellQuote(remotePath)} ${shellQuote(localDir)}`,
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || `Failed to download '${remotePath}' from sandbox '${sandboxName}'.`);
  }
}

function uploadToSandbox(sandboxName, localPath, remoteDir) {
  const result = run(
    `openshell sandbox upload ${shellQuote(sandboxName)} ${shellQuote(localPath)} ${shellQuote(remoteDir)}`,
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || `Failed to upload '${localPath}' into sandbox '${sandboxName}'.`);
  }
}

function buildRestoreArchiveScript(archivePath) {
  const uploadedArchivePath = path.posix.join("/tmp", path.basename(archivePath));
  const excludeArgs = RESTORE_EXCLUDES.map((entry) => `--exclude=${shellQuote(entry)}`).join(" ");
  return `set -eu\nif [ ${shellQuote(uploadedArchivePath)} != ${shellQuote(REMOTE_ARCHIVE_PATH)} ]; then mv ${shellQuote(uploadedArchivePath)} ${shellQuote(REMOTE_ARCHIVE_PATH)}; fi\ntar xzf ${shellQuote(REMOTE_ARCHIVE_PATH)} ${excludeArgs} -C /\nrm -f ${shellQuote(REMOTE_ARCHIVE_PATH)}`;
}

function buildBackupArchiveScript() {
  return `set -eu\nrm -f ${shellQuote(REMOTE_ARCHIVE_PATH)}\ntar czf ${shellQuote(REMOTE_ARCHIVE_PATH)} --ignore-failed-read -C / sandbox`;
}

function buildGatewayStopScript() {
  return `set -eu\npid="$(pidof -s openclaw 2>/dev/null || true)"\nif [ -z "$pid" ]; then\n  exit 0\nfi\nkill "$pid" 2>/dev/null || true\nfor _ in $(seq 1 30); do\n  if ! pidof -s openclaw >/dev/null 2>&1; then\n    exit 0\n  fi\n  sleep 1\ndone\npid="$(pidof -s openclaw 2>/dev/null || true)"\nif [ -n "$pid" ]; then\n  kill -9 "$pid" 2>/dev/null || true\nfi\nfor _ in $(seq 1 10); do\n  if ! pidof -s openclaw >/dev/null 2>&1; then\n    exit 0\n  fi\n  sleep 1\ndone\necho "Timed out waiting for the OpenClaw gateway to stop." >&2\nexit 1`;
}

function buildGatewayStartScript() {
  return `set -eu\nif pidof -s openclaw >/dev/null 2>&1; then\n  exit 0\nfi\nnohup ${shellQuote(START_SCRIPT_PATH)} >/tmp/gateway.log 2>&1 </dev/null &\nfor _ in $(seq 1 60); do\n  if pidof -s openclaw >/dev/null 2>&1; then\n    exit 0\n  fi\n  sleep 1\ndone\necho "Timed out waiting for the OpenClaw gateway to start." >&2\nexit 1`;
}

function isGatewayRunning(sandboxName) {
  const result = runSandboxScript(
    sandboxName,
    "set -eu\nif pidof -s openclaw >/dev/null 2>&1; then echo running; else echo stopped; fi",
    { ignoreError: true },
  );
  return (result.stdout || "").includes("running");
}

function withGatewayQuiesced(sandboxName, work) {
  const wasRunning = isGatewayRunning(sandboxName);
  if (wasRunning) {
    runSandboxScript(sandboxName, buildGatewayStopScript(), { ignoreError: false });
  }

  try {
    return work();
  } finally {
    if (wasRunning) {
      runSandboxScript(sandboxName, buildGatewayStartScript(), { ignoreError: false });
    }
  }
}

function listBackups(sandboxName) {
  const backupRoot = getSandboxBackupRoot(sandboxName);
  if (!fs.existsSync(backupRoot)) return [];

  return fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const backupDir = path.join(backupRoot, entry.name);
      const manifest = readManifest(backupDir);
      const stat = fs.statSync(backupDir);
      return {
        id: entry.name,
        path: backupDir,
        manifest,
        createdAt: manifest && manifest.createdAt ? manifest.createdAt : stat.mtime.toISOString(),
        sizeBytes: getDirectorySizeBytes(backupDir),
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function resolveBackup(sandboxName, selector = null) {
  const backups = listBackups(sandboxName);
  if (backups.length === 0) {
    throw new Error(`No backups found for sandbox '${sandboxName}'.`);
  }

  if (!selector) {
    return backups[0];
  }

  const match = backups.find((entry) => entry.id === selector);
  if (!match) {
    throw new Error(`Backup '${selector}' was not found for sandbox '${sandboxName}'.`);
  }
  return match;
}

function createBackup(sandboxName, options = {}) {
  const backupRoot = getSandboxBackupRoot(sandboxName);
  ensureSecureDirectory(path.dirname(backupRoot));
  ensureSecureDirectory(backupRoot);

  const backupId = normalizeBackupId(options.label) || formatTimestamp(options.now);
  const backupDir = path.join(backupRoot, backupId);
  if (fs.existsSync(backupDir)) {
    throw new Error(`Backup '${backupId}' already exists for sandbox '${sandboxName}'.`);
  }
  ensureSecureDirectory(backupDir);

  const manifest = _buildBackupManifest(sandboxName, options, backupId);
  writeManifest(backupDir, manifest);

  _createBackupArchive(sandboxName, backupDir);

  const finalArchivePath = _finalizeBackupArchive(backupDir);
  const sizeBytes = fs.existsSync(finalArchivePath) ? fs.statSync(finalArchivePath).size : 0;
  return {
    backupId,
    backupDir,
    manifest,
    archivePath: finalArchivePath,
    sizeBytes,
  };
}

function _buildBackupManifest(sandboxName, options, backupId) {
  const registryEntry = options.registryEntry ||
    registry.getSandbox(sandboxName) || { name: sandboxName };
  const inferredMetadata =
    !registryEntry.model || !registryEntry.provider ? getGatewayInferenceMetadata() : null;
  return buildManifest(sandboxName, {
    ...options,
    backupId,
    label: options.label ? normalizeBackupId(options.label) : null,
    registryEntry: {
      ...registryEntry,
      model: registryEntry.model || (inferredMetadata && inferredMetadata.model) || null,
      provider: registryEntry.provider || (inferredMetadata && inferredMetadata.provider) || null,
      providerBaseUrl:
        registryEntry.providerBaseUrl ||
        (inferredMetadata && inferredMetadata.providerBaseUrl) ||
        null,
    },
  });
}

function _createBackupArchive(sandboxName, backupDir) {
  try {
    withGatewayQuiesced(sandboxName, () => {
      runSandboxScript(sandboxName, buildBackupArchiveScript(), { ignoreError: false });
      downloadFromSandbox(sandboxName, REMOTE_ARCHIVE_PATH, backupDir);
    });
  } finally {
    runSandboxScript(sandboxName, `rm -f ${shellQuote(REMOTE_ARCHIVE_PATH)}`, {
      ignoreError: true,
    });
  }
}

function _finalizeBackupArchive(backupDir) {
  const archivePath = path.join(backupDir, path.basename(REMOTE_ARCHIVE_PATH));
  const finalArchivePath = path.join(backupDir, ARCHIVE_FILE);
  if (archivePath !== finalArchivePath && fs.existsSync(archivePath)) {
    fs.renameSync(archivePath, finalArchivePath);
  }
  return finalArchivePath;
}

function restoreBackup(sandboxName, backupDir) {
  const manifest = readManifest(backupDir);
  const archivePath = getArchivePath(backupDir, manifest);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Backup archive is missing from '${backupDir}'.`);
  }

  const uploadedArchivePath = path.posix.join("/tmp", path.basename(archivePath));

  try {
    withGatewayQuiesced(sandboxName, () => {
      uploadToSandbox(sandboxName, archivePath, "/tmp/");
      runSandboxScript(sandboxName, buildRestoreArchiveScript(archivePath), { ignoreError: false });
    });
  } finally {
    runSandboxScript(sandboxName, `rm -f ${shellQuote(uploadedArchivePath)}`, {
      ignoreError: true,
    });
    runSandboxScript(sandboxName, `rm -f ${shellQuote(REMOTE_ARCHIVE_PATH)}`, {
      ignoreError: true,
    });
  }

  return { manifest, archivePath };
}

module.exports = {
  ARCHIVE_FILE,
  BACKUP_ROOT,
  MANIFEST_FILE,
  MANIFEST_VERSION,
  RESTORE_EXCLUDES,
  buildBackupArchiveScript,
  buildGatewayStartScript,
  buildGatewayStopScript,
  buildManifest,
  buildRestoreArchiveScript,
  createBackup,
  formatTimestamp,
  getSandboxBackupRoot,
  hasSandboxBackups,
  getGatewayInferenceMetadata,
  isGatewayRunning,
  listBackups,
  normalizeBackupId,
  readManifest,
  resolveBackup,
  restoreBackup,
  runSandboxScript,
  withGatewayQuiesced,
};
