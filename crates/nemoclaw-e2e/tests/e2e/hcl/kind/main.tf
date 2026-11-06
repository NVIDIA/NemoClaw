# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The cluster objects a kind case needs before its first apply, released
# with the bundled Helm provider, as a platform or operator provides them:
# the deployment's namespace, prepared as OpenShift prepares a project with
# its UID range when the case selects the OpenShift profile, holding the
# registry pull Secret; a stub model in its own namespace that answers every
# chat completion with `reply`; and, when the case selects the oidc
# profile, an existing OIDC issuer in its own namespace and its CA. The test
# runner removes both releases, and with them these namespaces, after the
# case.

terraform {
  required_version = "= 1.12.12"
  required_providers {
    helm = {
      source = "hashicorp/helm"
    }
  }
}

variable "context" {
  type = object({
    config           = string
    probe_executable = string
    work_dir         = string
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

variable "pull_credentials" {
  description = "The login of the run's registry, which the case's sandbox images name."
  type = object({
    username = string
    password = string
  })
  sensitive = true
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
  # The registry that the sandbox images name, and the Secret the case pulls them with.
  registry = split("/", values(local.document.spec.sandboxes)[0].image.ref)[0]
  pull_secret = jsonencode({ auths = { (local.registry) = {
    auth = base64encode("${var.pull_credentials.username}:${var.pull_credentials.password}")
  } } })
  openshift = local.document.spec.gateway.runtime.provider == "openshift"
  # The existing issuer the gateway trusts, which the SDK's development
  # issuer image stands in for: its service is <name>-oidc in its namespace.
  oidc   = try(local.document.spec.gateway.config["openshell.gateway.oidc"], null)
  issuer = local.oidc == null ? null : regex("^https://(?P<name>[a-z0-9-]+)-oidc\\.(?P<namespace>[a-z0-9-]+)\\.svc\\.cluster\\.local:8443$", local.oidc.issuer)
}

# OpenTofu cannot sign the token, which must come from the issuer's key, so
# hcl_live::issuer creates the SDK's issuer material and objects and writes
# one token for the case's audience to the private credentials directory. The
# cli and verifier modules export each file there as the variable it names,
# which is the case's token.env; the token never enters OpenTofu values.
resource "terraform_data" "issuer" {
  count = local.oidc == null ? 0 : 1
  provisioner "local-exec" {
    command = "\"$NEMOCLAW_HCL_PROBE\" hcl_live::issuer --exact --ignored --quiet"
    environment = {
      NEMOCLAW_HCL_PROBE            = var.context.probe_executable
      NEMOCLAW_HCL_ISSUER           = local.oidc.issuer
      NEMOCLAW_HCL_ISSUER_NAME      = local.issuer.name
      NEMOCLAW_HCL_ISSUER_NAMESPACE = local.issuer.namespace
      NEMOCLAW_HCL_AUDIENCE         = local.oidc.audience
      NEMOCLAW_HCL_KEYS             = "${var.context.work_dir}/issuer"
      NEMOCLAW_HCL_OBJECTS          = "${var.context.work_dir}/${self.id}.issuer.json"
      NEMOCLAW_HCL_TOKEN            = "${var.context.work_dir}/credentials/${local.kubernetes.authentication.token.env}"
    }
  }
}

locals {
  # The issuer's NetworkPolicy admits only a gateway in the issuer's own
  # namespace, so an existing issuer that serves other namespaces omits it.
  issuer_objects = flatten([
    for issuer in terraform_data.issuer : [
      for object in jsondecode(file("${var.context.work_dir}/${issuer.id}.issuer.json")) :
      object if object.kind != "NetworkPolicy"
    ]
  ])
  issuer_ca = local.oidc == null ? null : one([
    for object in local.issuer_objects : object.data["ca.crt"]
    if object.kind == "ConfigMap" && object.metadata.name == "${local.issuer.name}-oidc-ca"
  ])
}

provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig
    config_context = local.kubernetes.context
  }
}

locals {
  # Both releases render the one chart; `part` selects their objects.
  values = {
    deploymentNamespace = local.kubernetes.namespace
    modelNamespace      = local.model
    # kind does not enforce OpenShift's constraints; the SDK and OpenShell
    # read this range as they do on OpenShift.
    uidRange = local.openshift ? "1000680000/10000" : null
    image    = local.image
    stream   = local.stream
    pullSecret = {
      name             = local.kubernetes.imagePullSecrets[0]
      dockerconfigjson = local.pull_secret
    }
    issuer = local.oidc == null ? null : {
      namespace   = local.issuer.namespace
      objects     = local.issuer_objects
      caConfigMap = local.kubernetes.authentication.caConfigMap
      ca          = local.issuer_ca
    }
  }
}

# The three namespaces, the pull Secret, and the issuer's CA, which are ready
# once created. Removing the release deletes the namespaces without waiting
# for Kubernetes to finalize them, about 10 s of the case, because nothing
# after the case needs them gone and the runner deletes the cluster. Its
# record is in `default`, which outlives the namespaces it deletes.
resource "helm_release" "namespaces" {
  name      = "${local.kubernetes.namespace}-namespaces"
  chart     = "${path.module}/model"
  namespace = "default"
  wait      = false
  timeout   = 180
  values    = [yamlencode(merge(local.values, { part = "namespaces" }))]
}

# The stub model and the issuer. The release waits until both are ready,
# before the case's first apply.
resource "helm_release" "model" {
  depends_on = [helm_release.namespaces]
  name       = "model"
  chart      = "${path.module}/model"
  namespace  = local.model
  wait       = true
  timeout    = 180
  values     = [yamlencode(merge(local.values, { part = "workloads" }))]
}

output "document" {
  description = "The case's document, for later run blocks that address what it names."
  value       = local.document
}
