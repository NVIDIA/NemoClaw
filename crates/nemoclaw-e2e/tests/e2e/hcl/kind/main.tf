# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The cluster objects a kind case needs before its first apply, released
# with the bundled Helm provider: the deployment's namespace, prepared as
# OpenShift prepares a project with its UID range, and a stub model in its
# own namespace that answers every chat completion with `reply`. The test
# runner removes the release, and with it both namespaces, after the case.

terraform {
  required_version = "= 1.12.9"
  required_providers {
    helm = {
      source = "hashicorp/helm"
    }
  }
}

variable "context" {
  type = object({
    config = string
  })
}

variable "kubeconfig" {
  description = "The kind cluster's kubeconfig file."
  type        = string
}

variable "reply" {
  description = "The text of every stub reply."
  type        = string
}

locals {
  document   = yamldecode(file(var.context.config))
  kubernetes = local.document.spec.gateway.kubernetes
  # The stub's namespace, from the endpoint its Service gives the case.
  model = regex("^http://model\\.([a-z0-9-]+)\\.svc", local.document.spec.inferenceProviders.stub.endpoint)[0]
  # The development issuer's pinned image serves nginx unprivileged.
  image = jsondecode(file("${path.module}/../../../../../../versions.json")).images.developmentIssuer
  # One OpenAI chat completion stream of the reply. nginx expands the
  # escaped line breaks in its single-quoted return text.
  chunks = [
    { delta = { role = "assistant" }, finish = null },
    { delta = { content = var.reply }, finish = null },
    { delta = {}, finish = "stop" },
  ]
  stream = join("", concat([
    for chunk in local.chunks : "data: ${jsonencode({
      id      = "chatcmpl-nemoclaw-stub"
      object  = "chat.completion.chunk"
      created = 0
      model   = "fixture-model"
      choices = [{ index = 0, delta = chunk.delta, finish_reason = chunk.finish }]
    })}\\n\\n"
  ], ["data: [DONE]\\n\\n"]))
}

provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig
    config_context = local.kubernetes.context
  }
}

resource "helm_release" "model" {
  name             = "model"
  chart            = "${path.module}/model"
  namespace        = local.model
  create_namespace = true
  wait             = true
  timeout          = 180
  values = [yamlencode({
    deploymentNamespace = local.kubernetes.namespace
    # kind does not enforce OpenShift's constraints; the SDK and OpenShell
    # read this range as they do on OpenShift.
    uidRange = "1000680000/10000"
    image    = local.image
    stream   = local.stream
  })]
}
