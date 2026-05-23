// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Compatibility front controller for NemoClaw's public CLI surface.
//
// Keep this file intentionally small: the public grammar adapter lives in
// src/lib/cli/public-dispatch.ts, while oclif owns command discovery, parsing,
// help rendering, and command execution under src/commands/**.
import { dispatchCli } from "./lib/cli/public-dispatch";

exports.main = dispatchCli;
module.exports.dispatchCli = dispatchCli;
// Compatibility for tests that require the CLI module and await completion.
// Prefer calling dispatchCli(argv) directly in new in-process harnesses.
exports.mainPromise =
  process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH === "1" ? Promise.resolve() : dispatchCli();
