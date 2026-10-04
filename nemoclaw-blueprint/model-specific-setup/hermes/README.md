<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Model-Specific Setup

Hermes-specific model/provider compatibility manifests belong in this directory and must declare `"agent": "hermes"`.

This directory intentionally has no Kimi K2.6 manifest yet. Add one only after a Hermes-specific failure or acceptance test proves Hermes needs a compatibility layer. Hermes executable wrappers and runtime code belong under `agents/hermes/`; registry manifests should stay declarative.
