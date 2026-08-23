// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep the generalized implementation in the established Docker module so the
// shipped Docker surface and its import path remain stable. Candidate providers
// consume only this provider-neutral facade.
export {
  createContainerStateMutationOwner,
  createContainerStateMutationSurface,
  type ContainerStateMutationAuthority,
  type ContainerStateMutationOwner,
  type ContainerStateMutationOwnerOptions,
  type ContainerStateMutationSurfaceOptions,
} from "./docker-state-mutation";
