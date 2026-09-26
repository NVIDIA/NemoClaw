// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

export const ADMIN_REQUEST_SELECTOR_PY = readFileSync(
  new URL("../lib/issue-4462-admin-request-selector.py", import.meta.url),
  "utf8",
).trimEnd();
