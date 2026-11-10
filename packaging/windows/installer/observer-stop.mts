// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function signalObserverStop(sentinel: string) {
  // Exclusive creation is the check: never overwrite a pre-existing stop path.
  fs.closeSync(fs.openSync(sentinel, "wx", 0o600));
}
