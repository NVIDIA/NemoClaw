// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const E2E_ROOT = path.join(REPO_ROOT, "test", "e2e");
export const LIVE_E2E_ROOT = path.join(E2E_ROOT, "live");
export const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
export const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
