# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A stub OpenAI-compatible model for a Docker case, run with the bundled
# Docker provider on the case's engine before its first apply: the pinned
# nginx-unprivileged image the development issuer runs, on the host network
# at the port the case's `model` provider names. It lists one model and
# answers every chat completion with `reply`, streamed when the request asks,
# followed by the name of each of `markers` that the request holds, so a
# test can see what an agent sent the model. It refuses any request without
# `Authorization: Bearer KEY`. The test runner removes it after the case.

terraform {
  required_version = "= 1.12.12"
  required_providers {
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

variable "context" {
  type = object({
    config   = string
    versions = string
  })
}

variable "key" {
  description = "The key the case's provider sends, which the stub requires."
  type        = string
  sensitive   = true
}

variable "reply" {
  description = "The text that starts every completion."
  type        = string
  # nginx puts the reply in a header and in the completion's JSON unescaped.
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.reply))
    error_message = "The reply must be one word of letters, digits, '.', '_', and '-'."
  }
}

variable "markers" {
  description = "By name, text to look for in each chat completion request. The completion names each marker its request holds, in name order, after the reply."
  type        = map(string)
  default     = {}
  # nginx matches the text as a regular expression and puts the name in the
  # completion's JSON unescaped.
  validation {
    condition = alltrue([
      for name, text in var.markers :
      can(regex("^[a-z0-9-]+$", name)) && can(regex("^[A-Za-z0-9-]+$", text))
    ])
    error_message = "Marker names must be lowercase letters, digits, and '-', and marker text letters, digits, and '-'."
  }
}

locals {
  document = yamldecode(file(var.context.config))
  port     = tonumber(regex(":([0-9]+)/v1$", local.document.spec.inferenceProviders.model.endpoint)[0])
  image    = jsondecode(file(var.context.versions)).images.developmentIssuer
  # Only the server that reads the request body can match it, so it composes
  # the completion's text from `reply` and one variable per marker, which
  # holds the marker's name when the body holds its text.
  marker_names = sort(keys(var.markers))
  marker_maps = join("\n", [
    for index, name in local.marker_names :
    "    map $request_body $marker_${index} { \"~${var.markers[name]}\" \" ${name}\"; default \"\"; }"
  ])
  text = join("", concat([var.reply], [for index, _ in local.marker_names : "$marker_${index}"]))
  # Responses, as nginx returns them: it expands the escaped line breaks in
  # single-quoted text, and $http_x_reply to the text the first server composed.
  models = jsonencode({ object = "list", data = [{ id = "fixture-model", object = "model" }] })
  completion = jsonencode({
    id      = "chatcmpl-nemoclaw-stub"
    object  = "chat.completion"
    created = 0
    model   = "fixture-model"
    choices = [{ index = 0, message = { role = "assistant", content = "$http_x_reply" }, finish_reason = "stop" }]
    usage   = { prompt_tokens = 1, completion_tokens = 1, total_tokens = 2 }
  })
  chunks = [
    { delta = { role = "assistant", content = "$http_x_reply" }, finish = null, usage = null },
    { delta = {}, finish = "stop", usage = { prompt_tokens = 1, completion_tokens = 1, total_tokens = 2 } },
  ]
  stream = join("", concat([
    for chunk in local.chunks : "data: ${jsonencode(merge({
      id      = "chatcmpl-nemoclaw-stub"
      object  = "chat.completion.chunk"
      created = 0
      model   = "fixture-model"
      choices = [{ index = 0, delta = chunk.delta, finish_reason = chunk.finish }]
    }, chunk.usage == null ? {} : { usage = chunk.usage }))}\\n\\n"
  ], ["data: [DONE]\\n\\n"]))
  # The request body selects a streamed reply and the completion's text. nginx
  # reads the body before it sends the proxied request, so the second server
  # sees both as headers.
  config = <<-EOT
    worker_processes 1;
    pid /tmp/nginx.pid;
    error_log /dev/stderr warn;
    events { worker_connections 1024; }
    http {
        access_log /dev/stdout;
        client_body_temp_path /tmp/client_temp;
        proxy_temp_path /tmp/proxy_temp;
        fastcgi_temp_path /tmp/fastcgi_temp;
        uwsgi_temp_path /tmp/uwsgi_temp;
        scgi_temp_path /tmp/scgi_temp;
        map $request_body $reply_kind {
            "~\"stream\"\s*:\s*true" stream;
            default plain;
        }
    ${local.marker_maps}
        server {
            listen ${local.port};
            if ($http_authorization != "Bearer ${var.key}") { return 401; }
            location = /v1/models {
                default_type application/json;
                return 200 '${local.models}';
            }
            location = /v1/chat/completions {
                client_body_buffer_size 1m;
                client_body_in_single_buffer on;
                proxy_set_header X-Reply-Kind $reply_kind;
                proxy_set_header X-Reply "${local.text}";
                proxy_pass http://unix:/tmp/stub.sock:/completion;
            }
            location / { return 404; }
        }
        server {
            listen unix:/tmp/stub.sock;
            location = /completion {
                if ($http_x_reply_kind = stream) { rewrite ^ /stream last; }
                default_type application/json;
                return 200 '${local.completion}';
            }
            location = /stream {
                default_type text/event-stream;
                return 200 '${local.stream}';
            }
        }
    }
  EOT
}

provider "docker" {
  host = local.document.spec.gateway.engine
}

resource "docker_image" "model" {
  name         = local.image
  keep_locally = true
}

resource "docker_container" "model" {
  name         = "nc-hcl-model-${substr(sha256(local.document.metadata.uid), 0, 12)}"
  image        = docker_image.model.image_id
  network_mode = "host"
  must_run     = true
  command      = ["nginx", "-c", "/tmp/stub.conf", "-g", "daemon off;"]
  upload {
    content = local.config
    file    = "/tmp/stub.conf"
  }
  # live-docker removes anything left with the deployment's UID label.
  labels {
    label = "nemoclaw.nvidia.com/uid"
    value = local.document.metadata.uid
  }
}
