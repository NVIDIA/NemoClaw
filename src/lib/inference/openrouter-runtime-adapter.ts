// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { adapterAuthorizationHash, adapterConfigHash } from "./openrouter-runtime-adapter-common";

export {
  LOG_PATH,
  adapterAuthorizationHash,
  adapterConfigHash,
} from "./openrouter-runtime-adapter-common";
export { ensureOpenRouterRuntimeAdapter } from "./openrouter-runtime-adapter-lifecycle";
export {
  createOpenRouterRuntimeAdapterServer,
  startOpenRouterRuntimeAdapterFromEnv,
} from "./openrouter-runtime-adapter-server";

export const __test = {
  adapterAuthorizationHash,
  adapterConfigHash,
};
