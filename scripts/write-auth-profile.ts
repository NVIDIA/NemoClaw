#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const path = join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
const profile = {
  "nvidia:manual": {
    type: "api_key",
    provider: "nvidia",
    keyRef: { source: "env", id: "NVIDIA_API_KEY" },
    profileId: "nvidia:manual",
  },
};

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(profile));
chmodSync(path, 0o600);
console.log(`Wrote auth profile to ${path}`);
