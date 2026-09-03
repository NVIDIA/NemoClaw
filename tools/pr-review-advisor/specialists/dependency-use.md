<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Dependency use

Determine whether the change uses existing dependencies and platform capabilities directly and proportionately.

A good dependency review compares new wrappers, adapters, parsers, caches, registries, and compatibility code with the capabilities already provided by the repository, language runtime, and selected dependencies. It considers whether removing custom code would preserve the required behavior and trust boundaries.

Report a finding when an existing supported capability can replace new repository code, or when a dependency introduces more integration code than the outcome warrants. Name the code that can be removed, the capability that replaces it, and the required behavior and trust-boundary guarantees the replacement retains.
