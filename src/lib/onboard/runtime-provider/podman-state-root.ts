// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveNemoclawStateDir } from "../../state/paths";

/** Provider-owned state root shared by the registered Podman surfaces. */
export function resolvePodmanStateRoot(homeDir?: string): string {
  return resolveNemoclawStateDir(homeDir);
}
