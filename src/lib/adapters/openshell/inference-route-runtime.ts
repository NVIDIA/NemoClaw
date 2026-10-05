// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellInferenceRouteMutator } from "./inference-route";
import {
  createCliOpenShellInferenceRouteMutator,
  createCliOpenShellInferenceRouteObserver,
  createSynchronousCliOpenShellInferenceRouteObserver,
  type CliOpenShellInferenceRouteMutatorOptions,
} from "./inference-route-cli";
import * as runtime from "./runtime";

/** Prime the default CLI transport before a caller enters a mutation lock. */
export function prepareCliOpenShellInferenceRouteTransport(): void {
  runtime.getOpenshellBinary();
}

/** Default synchronous observer backed by the resolved OpenShell CLI. */
export const cliOpenShellSynchronousInferenceRouteObserver =
  createSynchronousCliOpenShellInferenceRouteObserver(runtime.captureOpenshell);

/** Create a default asynchronous observer backed by the resolved OpenShell CLI. */
export function createDefaultCliOpenShellInferenceRouteObserver() {
  return createCliOpenShellInferenceRouteObserver(runtime.captureResolvedOpenshellAsync);
}

/** Create a default CLI mutator while retaining consumer-owned diagnostic redaction. */
export function createDefaultCliOpenShellInferenceRouteMutator(
  options: CliOpenShellInferenceRouteMutatorOptions = {},
): OpenShellInferenceRouteMutator {
  return createCliOpenShellInferenceRouteMutator(runtime.captureResolvedOpenshellAsync, options);
}
