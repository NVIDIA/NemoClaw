# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Registry pull Secrets that the configuration names in OpenShell's driver
# table reach the sandbox driver. The gateway's and helper's pod templates,
# which pull OpenShell's public images, name none, and the chart owns none.

run "pull_secrets" {
  command = plan

  variables {
    values = ["inputs/pull-secrets.json"]
  }

  assert {
    condition = alltrue([
      for object in output.objects : length(try(object.spec.template.spec.imagePullSecrets, [])) == 0
      if contains(["StatefulSet", "Job"], object.kind)
    ])
    error_message = "The gateway and helper pod templates must name no pull Secrets."
  }

  assert {
    condition     = can(regex("image_pull_secrets\\s*=\\s*\\[\\s*\"registry-team\",\\s*\"registry.backup\",?\\s*\\]", output.configuration))
    error_message = "The sandbox driver must receive both pull Secret names."
  }

  assert {
    condition     = !anytrue([for object in output.objects : object.kind == "Secret" && contains(["registry-team", "registry.backup"], object.metadata.name)])
    error_message = "The chart must not own the caller's registry Secrets."
  }
}
