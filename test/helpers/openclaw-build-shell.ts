// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

/** Inline the shipped sourced installer before applying isolated fixture paths. */
export function resolveSourcedDockerBuildShell(command: string): string {
  return command.replace(/\. \/scripts\/lib\/install-openclaw-optional-plugins\.sh\b/g, () =>
    fs.readFileSync(
      new URL("../../scripts/lib/install-openclaw-optional-plugins.sh", import.meta.url),
      "utf8",
    ),
  );
}
