# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# With the OpenShift profile, the gateway runs as the user and group the
# authentication resource observed in the namespace's assigned range.

run "openshift" {
  command = plan

  variables {
    values = ["inputs/openshift.json", "inputs/openshift-identity.json"]
  }

  assert {
    condition = (
      strcontains(output.manifest, "runAsUser: 1000680000")
      && strcontains(output.manifest, "fsGroup: 1000690000")
      && strcontains(output.manifest, "runAsNonRoot: true")
      && !strcontains(output.manifest, "runAsUser: 1000\n")
    )
    error_message = "The gateway must take the namespace's assigned user and group."
  }

  assert {
    condition = length(setintersection(
      toset([for object in output.objects : "${object.kind}/${object.metadata.name}"]),
      toset([for object in jsondecode(file("inputs/prepared.json")) : "${object.kind}/${object.name}"]),
    )) == 0 && !anytrue([for object in output.objects : object.kind == "Namespace"])
    error_message = "Helm must not own a namespace or any object NemoClaw prepares."
  }
}
