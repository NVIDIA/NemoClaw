// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Central port configuration — thin shim over the TypeScript source.
// Override any port via environment variables.
// Based on the approach from jnun (PR #683).

module.exports = require("../../dist/lib/ports");
