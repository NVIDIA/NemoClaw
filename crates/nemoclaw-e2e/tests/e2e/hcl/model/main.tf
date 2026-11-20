# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A stub model for a Docker case, run with the bundled Docker provider on the
# case's engine before its first apply: the pinned nginx-unprivileged image
# the development issuer runs, on the host network at the port the case's
# `model` provider names. It lists one model and answers every OpenAI chat
# completion, and every Anthropic Messages request at /anthropic/v1/messages
# as Anthropic-compatible gateways serve them, with `reply`, streamed when the
# request asks, followed by the name of each of `markers` that the request
# holds, so a test can see what an agent sent the model. It refuses a
# Messages request without `x-api-key: KEY`, where Anthropic's API takes the
# key, and any other request without `Authorization: Bearer KEY`. The test
# runner removes it after the case.

terraform {
  required_version = "= 1.13.9"
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
  description = "The text that starts every completion and message."
  type        = string
  # nginx puts the reply in a header and in the completion's JSON unescaped.
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.reply))
    error_message = "The reply must be one word of letters, digits, '.', '_', and '-'."
  }
}

variable "port" {
  description = "The port to serve on, in place of the one the case's `model` provider names."
  type        = number
  default     = null
}

variable "enabled" {
  description = "Whether to serve the stub, so a scenario that runs for several rows can leave it out."
  type        = bool
  default     = true
}

variable "markers" {
  description = "By name, text to look for in each chat completion or Messages request. The completion or message names each marker its request holds, in name order, after the reply."
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
  port     = var.port != null ? var.port : tonumber(regex(":([0-9]+)/v1$", local.document.spec.inferenceProviders.model.endpoint)[0])
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
  # A Messages reply, and the events that stream it.
  message = jsonencode({
    id            = "msg_nemoclaw_stub"
    type          = "message"
    role          = "assistant"
    model         = "fixture-model"
    content       = [{ type = "text", text = "$http_x_reply" }]
    stop_reason   = "end_turn"
    stop_sequence = null
    usage         = { input_tokens = 1, output_tokens = 1 }
  })
  events = [
    {
      type = "message_start"
      message = {
        id            = "msg_nemoclaw_stub"
        type          = "message"
        role          = "assistant"
        model         = "fixture-model"
        content       = []
        stop_reason   = null
        stop_sequence = null
        usage         = { input_tokens = 1, output_tokens = 0 }
      }
    },
    { type = "content_block_start", index = 0, content_block = { type = "text", text = "" } },
    { type = "content_block_delta", index = 0, delta = { type = "text_delta", text = "$http_x_reply" } },
    { type = "content_block_stop", index = 0 },
    { type = "message_delta", delta = { stop_reason = "end_turn", stop_sequence = null }, usage = { output_tokens = 1 } },
    { type = "message_stop" },
  ]
  message_stream = join("", [
    for event in local.events : "event: ${event.type}\\ndata: ${jsonencode(event)}\\n\\n"
  ])
  # The request body selects a streamed reply and the reply's text. nginx
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
            set $credential $http_authorization;
            if ($uri = /anthropic/v1/messages) { set $credential "Bearer $http_x_api_key"; }
            if ($credential != "Bearer ${var.key}") { return 401; }
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
            location = /anthropic/v1/messages {
                client_body_buffer_size 1m;
                client_body_in_single_buffer on;
                proxy_set_header X-Reply-Kind $reply_kind;
                proxy_set_header X-Reply "${local.text}";
                proxy_pass http://unix:/tmp/stub.sock:/message;
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
            location = /message {
                if ($http_x_reply_kind = stream) { rewrite ^ /message-stream last; }
                default_type application/json;
                return 200 '${local.message}';
            }
            location = /message-stream {
                default_type text/event-stream;
                return 200 '${local.message_stream}';
            }
        }
    }
  EOT
}

provider "docker" {
  host = local.document.spec.gateway.engine
}

resource "docker_image" "model" {
  count        = var.enabled ? 1 : 0
  name         = local.image
  keep_locally = true
}

resource "docker_container" "model" {
  count        = var.enabled ? 1 : 0
  name         = "nc-hcl-model-${substr(sha256(local.document.metadata.uid), 0, 12)}"
  image        = docker_image.model[0].image_id
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
