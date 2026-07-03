// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerRebuildFlowLifecycleTests } from "../../../../test/helpers/rebuild-flow-lifecycle-cases";
import { registerRebuildFlowRecoveryTests } from "../../../../test/helpers/rebuild-flow-recovery-cases";
import { registerRebuildFlowTargetCredentialsTests } from "../../../../test/helpers/rebuild-flow-target-credentials-cases";
import { registerRebuildFlowTargetImageTests } from "../../../../test/helpers/rebuild-flow-target-image-cases";
import { registerRebuildFlowTargetSessionTests } from "../../../../test/helpers/rebuild-flow-target-session-cases";

registerRebuildFlowLifecycleTests();
registerRebuildFlowRecoveryTests();
registerRebuildFlowTargetSessionTests();
registerRebuildFlowTargetCredentialsTests();
registerRebuildFlowTargetImageTests();
