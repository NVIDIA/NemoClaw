// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Debug logger for verbose/diagnostic output.
// Usage:
//   LOG_LEVEL=debug nemoclaw onboard
//   nemoclaw --verbose onboard

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let currentLevel = LOG_LEVELS.info;

function setLevel(level) {
  const resolved = LOG_LEVELS[level];
  if (resolved !== undefined) {
    currentLevel = resolved;
  }
}

function isVerbose() {
  return currentLevel >= LOG_LEVELS.debug;
}

function debug(...args) {
  if (currentLevel >= LOG_LEVELS.debug) {
    console.error("  [debug]", ...args);
  }
}

// Initialize from environment
const envLevel = (process.env.LOG_LEVEL || process.env.NEMOCLAW_LOG_LEVEL || "").toLowerCase();
if (envLevel && LOG_LEVELS[envLevel] !== undefined) {
  setLevel(envLevel);
}

module.exports = { LOG_LEVELS, setLevel, isVerbose, debug };
