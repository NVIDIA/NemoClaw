// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export { readManagedGatewayRuntimeBinding } from "../docker-driver-gateway-config";
export { ensureDockerDriverGatewayLocalTlsBundle as ensureManagedGatewayLocalTlsBundle } from "../docker-driver-gateway-local-tls";
export { isLinuxDockerDriverGatewayEnabled } from "../docker-driver-platform";
export * from "./host-local-inference-runtime";
/**
 * Driver-neutral onboarding runtime facade.
 *
 * The large onboarding coordinator consumes one compute boundary while each
 * registered driver keeps its own selection, lifecycle, preflight, and
 * reachability implementation. New drivers such as MXC extend this boundary
 * without adding another direct dependency to the coordinator.
 */
export * from "./managed-gateway-profile";
export * from "./managed-startup-runtime-requirements";
export * from "./plan";
export * from "./podman/active-watcher";
export * from "./podman/gateway-env";
export * from "./podman/gateway-reachability";
export * from "./podman/sandbox-create-authority";
export * from "./podman/socket-authority";
export * from "./podman-preflight";
export * from "./recovery-runtime";
export * from "./runtime-authority";
