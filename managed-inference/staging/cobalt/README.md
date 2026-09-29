<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Cobalt staging

Cobalt is inactive configuration for review, not a runnable or supported model.
The production catalog generator reads only `models/`, `recipes/`, and `presets/`; it does not read this directory.
The staged preset also disables selection. No feature flag enables it.

Scope: [#12492](https://github.com/NVIDIA/NemoClaw/issues/12492).

The model identity, zero revision and image digest, one-byte sizes, capability flags, and serving limits are placeholders.
They are not download instructions, qualification evidence, or performance recommendations.
Keep private artifacts, credentials, identities, and test results outside this repository.

Activation requires a separate reviewed change:

1. Record the released model identity, immutable revision, file manifest, and runtime image digest.
2. Replace all placeholder values and validate the complete serving configuration on the target hardware.
3. Qualify chat, media and tools as applicable, plus authentication, restart, rebuild, cleanup, and recovery.
4. Promote the reviewed documents into the production catalog and set selection and support states from accepted evidence.
5. Review any proposed default or fallback change separately from staging.

Renaming Cobalt, setting a feature flag, or copying these files without replacing and qualifying the placeholders does not establish support.
