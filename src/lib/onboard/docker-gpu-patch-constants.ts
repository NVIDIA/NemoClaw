// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Default timeout for one Docker CLI operation in the compatibility GPU patch path. */
export const DOCKER_GPU_PATCH_TIMEOUT_MS = 30_000;

/**
 * Docker may still be flushing a just-built image when the compatibility path stops the
 * provisioning container. Give that state transition a longer client deadline while keeping
 * every other mutation on the short default timeout.
 */
export const DOCKER_GPU_PATCH_STOP_TIMEOUT_MS = 90_000;
