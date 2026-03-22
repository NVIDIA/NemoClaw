#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Backwards-compatible wrapper — delegates to the generic bridge runner.
// Users and scripts that reference this path directly will continue to work.

process.argv.splice(2, 0, "telegram");
require("./bridge");
