// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_NOTICE_CONFIG_PATH = path.join(__dirname, "..", "config", "onboard-notice.json");

function getOnboardNoticeStatePath() {
  const home = process.env.HOME || os.homedir() || "/tmp";
  return (
    process.env.NEMOCLAW_ONBOARD_NOTICE_STATE || path.join(home, ".nemoclaw", "onboard-notice.json")
  );
}

function getOnboardNoticeConfigPath() {
  return process.env.NEMOCLAW_ONBOARD_NOTICE_CONFIG || DEFAULT_NOTICE_CONFIG_PATH;
}

function validateNoticeConfig(config, sourcePath) {
  const requiredFields = ["version", "title", "summary", "details", "url", "prompt"];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid onboard notice config: ${sourcePath}`);
  }
  for (const field of requiredFields) {
    if (typeof config[field] !== "string" || config[field].trim().length === 0) {
      throw new Error(`Invalid onboard notice config field '${field}': ${sourcePath}`);
    }
  }
  return {
    version: config.version.trim(),
    title: config.title.trim(),
    summary: config.summary.trim(),
    details: config.details.trim(),
    url: config.url.trim(),
    prompt: config.prompt,
  };
}

function loadOnboardNoticeConfig(configPath = getOnboardNoticeConfigPath()) {
  const raw = fs.readFileSync(configPath, "utf-8");
  return validateNoticeConfig(JSON.parse(raw), configPath);
}

function loadOnboardNoticeState(statePath = getOnboardNoticeStatePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return {
      lastSeenVersion:
        typeof raw?.lastSeenVersion === "string" && raw.lastSeenVersion.length > 0
          ? raw.lastSeenVersion
          : null,
      lastSeenAt:
        typeof raw?.lastSeenAt === "string" && raw.lastSeenAt.length > 0 ? raw.lastSeenAt : null,
    };
  } catch {
    return { lastSeenVersion: null, lastSeenAt: null };
  }
}

function shouldShowOnboardNotice(config, state = loadOnboardNoticeState()) {
  return !config || state.lastSeenVersion !== config.version;
}

function saveOnboardNoticeState(version, statePath = getOnboardNoticeStatePath()) {
  const dir = path.dirname(statePath);
  const tmpPath = path.join(
    dir,
    `.onboard-notice.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(
    {
      lastSeenVersion: version,
      lastSeenAt: new Date().toISOString(),
    },
    null,
    2,
  );
  try {
    fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; preserve the original write/rename error.
    }
    throw error;
  }
}

function renderOnboardNoticeLines(config) {
  return [
    "",
    `  ${config.title}`,
    `  ${"─".repeat(config.title.length)}`,
    `  ${config.summary}`,
    `  ${config.details}`,
    `    ${config.url}`,
  ];
}

async function showOnboardNoticeIfNeeded(options = {}) {
  const config = loadOnboardNoticeConfig(options.configPath);
  const statePath = options.statePath || getOnboardNoticeStatePath();
  const state = loadOnboardNoticeState(statePath);
  if (!shouldShowOnboardNotice(config, state)) {
    return { shown: false, version: config.version };
  }

  const writeLine =
    options.writeLine ||
    ((line) => {
      process.stderr.write(`${line}\n`);
    });

  for (const line of renderOnboardNoticeLines(config)) {
    writeLine(line);
  }

  if (options.nonInteractive) {
    writeLine("  [non-interactive] Continuing after logging the usage notice.");
  } else {
    const promptFn = options.promptFn;
    if (typeof promptFn !== "function") {
      throw new Error("Interactive onboard notice requires a prompt function.");
    }
    await promptFn(`  ${config.prompt}`);
  }

  try {
    saveOnboardNoticeState(config.version, statePath);
  } catch (error) {
    writeLine(
      `  Warning: could not persist usage notice state at ${statePath}: ${error?.message || String(error)}`,
    );
  }

  return { shown: true, version: config.version };
}

module.exports = {
  DEFAULT_NOTICE_CONFIG_PATH,
  getOnboardNoticeConfigPath,
  getOnboardNoticeStatePath,
  loadOnboardNoticeConfig,
  loadOnboardNoticeState,
  renderOnboardNoticeLines,
  saveOnboardNoticeState,
  shouldShowOnboardNotice,
  showOnboardNoticeIfNeeded,
  validateNoticeConfig,
};
