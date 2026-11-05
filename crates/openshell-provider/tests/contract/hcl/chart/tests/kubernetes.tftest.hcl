# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A managed Kubernetes gateway with the development profile: the release owns
# the gateway StatefulSet and none of the objects NemoClaw prepares, keeps the
# chart's gateway UID and the pinned image, and makes the gateway accept only
# tokens from the deployment's own issuer.

run "kubernetes" {
  command = plan

  variables {
    values = ["inputs/kubernetes.json"]
  }

  assert {
    condition     = length([for object in output.objects : object if object.kind == "StatefulSet" && object.metadata.name == output.release]) == 1
    error_message = "The release must own exactly one gateway StatefulSet."
  }

  assert {
    condition = length(setintersection(
      toset([for object in output.objects : "${object.kind}/${object.metadata.name}"]),
      toset([for object in jsondecode(file("inputs/prepared.json")) : "${object.kind}/${object.name}"]),
    )) == 0 && !anytrue([for object in output.objects : object.kind == "Namespace"])
    error_message = "Helm must not own a namespace or any object NemoClaw prepares."
  }

  assert {
    condition = (
      strcontains(output.manifest, "runAsUser: 1000\n")
      && strcontains(output.manifest, "${jsondecode(file("inputs/kubernetes.json")).gateway.image.repository}@${jsondecode(file("inputs/kubernetes.json")).gateway.image.digest}")
      && strcontains(output.manifest, "${output.release}-kek")
    )
    error_message = "The gateway must keep the chart's UID, the pinned image, and its key Secret's name."
  }

  assert {
    condition = (
      can(regex("allow_unauthenticated_users\\s*=\\s*false", output.configuration))
      # The deployment's own issuer Service, and its owner as the audience.
      && strcontains(output.configuration, "\"https://${output.release}-oidc.agents.svc.cluster.local:")
      && strcontains(output.configuration, "\"11111111-1111-4111-8111-111111111111\"")
    )
    error_message = "The gateway must refuse unauthenticated users and trust only the deployment's own issuer and audience."
  }
}
