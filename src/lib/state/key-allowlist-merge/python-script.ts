// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { KEY_ALLOWLIST_CONFIG_PYTHON } from "./python-config.js";
import { KEY_ALLOWLIST_ENTRYPOINT_PYTHON } from "./python-entrypoint.js";
import { KEY_ALLOWLIST_OWNERSHIP_PYTHON } from "./python-ownership.js";
import { KEY_ALLOWLIST_SERIALIZATION_PYTHON } from "./python-serialization.js";

/** Complete isolated Python program passed to the sandbox interpreter. */
export const KEY_ALLOWLIST_MERGE_PYTHON = [
  KEY_ALLOWLIST_CONFIG_PYTHON,
  KEY_ALLOWLIST_OWNERSHIP_PYTHON,
  KEY_ALLOWLIST_SERIALIZATION_PYTHON,
  KEY_ALLOWLIST_ENTRYPOINT_PYTHON,
].join("\n\n\n");
