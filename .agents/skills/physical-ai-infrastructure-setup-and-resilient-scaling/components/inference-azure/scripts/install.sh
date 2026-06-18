#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Deploy a serverless model endpoint in Azure AI Foundry
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${TF_DIR:-$SCRIPT_DIR/../../cluster-azure/scripts}"

# ---------- Defaults ----------
ENDPOINT_NAME="${ENDPOINT_NAME:-llama-3-1-8b}"
MODEL_ID="${MODEL_ID:-azureml://registries/azureml-meta/models/Meta-Llama-3.1-8B-Instruct}"
RESOURCE_GROUP="${RESOURCE_GROUP:-}"
PROJECT_NAME="${PROJECT_NAME:-}"
CONFIG_PREVIEW=false

show_help() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Deploy a serverless model endpoint to Azure AI Foundry.

OPTIONS:
    -n, --endpoint-name NAME   Endpoint name (default: $ENDPOINT_NAME)
    -m, --model-id ID          Model ID (default: Meta Llama 3.1 8B)
    -g, --resource-group RG    Azure resource group
    -p, --project NAME         Foundry project name
    -t, --tf-dir DIR           Terraform directory for auto-detect (default: ../../cluster-azure/scripts)
    --list                     List existing endpoints and exit
    --config-preview           Print configuration and exit
    -h, --help                 Show this help

EXAMPLES:
    $(basename "$0")
    $(basename "$0") --model-id azureml://registries/azureml-deepseek/models/DeepSeek-R1
    $(basename "$0") --list
EOF
}

LIST_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--endpoint-name) ENDPOINT_NAME="$2"; shift 2 ;;
    -m|--model-id)      MODEL_ID="$2"; shift 2 ;;
    -g|--resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    -p|--project)       PROJECT_NAME="$2"; shift 2 ;;
    -t|--tf-dir)        TF_DIR="$2"; shift 2 ;;
    --list)             LIST_ONLY=true; shift ;;
    --config-preview)   CONFIG_PREVIEW=true; shift ;;
    -h|--help)          show_help; exit 0 ;;
    *)                  echo "Unknown option: $1"; exit 1 ;;
  esac
done

RESOURCE_GROUP="${RESOURCE_GROUP}" PROJECT_NAME="${PROJECT_NAME}" TF_DIR="${TF_DIR}" \
  "${SCRIPT_DIR}/preflight.sh"

# ---------- Auto-detect from TF outputs ----------
if [[ -z "$RESOURCE_GROUP" || -z "$PROJECT_NAME" ]]; then
  if command -v terraform &>/dev/null && [[ -f "$TF_DIR/main.tf" ]]; then
    echo "Reading terraform outputs..."
    if [[ -z "$RESOURCE_GROUP" ]]; then
      if RESOURCE_GROUP=$(terraform -chdir="$TF_DIR" output -raw resource_group 2>/dev/null); then
        :
      else
        RESOURCE_GROUP=""
      fi
    fi
    if [[ -z "$PROJECT_NAME" ]]; then
      if PROJECT_NAME=$(terraform -chdir="$TF_DIR" output -raw foundry_project 2>/dev/null); then
        :
      else
        PROJECT_NAME=""
      fi
    fi
  fi
fi

[[ -z "$RESOURCE_GROUP" ]] && { echo "ERROR: --resource-group required (or set TF_DIR)"; exit 1; }
[[ -z "$PROJECT_NAME" ]]   && { echo "ERROR: --project required (or set TF_DIR)"; exit 1; }

# Configure az ml defaults
az configure --defaults workspace="$PROJECT_NAME" group="$RESOURCE_GROUP" 2>/dev/null

# ---------- List mode ----------
if [[ "$LIST_ONLY" == "true" ]]; then
  echo "==> Serverless endpoints in project '$PROJECT_NAME':"
  az ml serverless-endpoint list -o table 2>/dev/null || echo "(none)"
  exit 0
fi

# ---------- Config preview ----------
if [[ "$CONFIG_PREVIEW" == "true" ]]; then
  echo "Configuration:"
  echo "  Resource Group: $RESOURCE_GROUP"
  echo "  Project:        $PROJECT_NAME"
  echo "  Endpoint Name:  $ENDPOINT_NAME"
  echo "  Model ID:       $MODEL_ID"
  exit 0
fi

# ---------- Deploy ----------
echo "==> Deploying serverless endpoint '$ENDPOINT_NAME'"
echo "    Model: $MODEL_ID"
echo "    Project: $PROJECT_NAME"
echo ""

# Check if endpoint already exists with matching model
if az ml serverless-endpoint show -n "$ENDPOINT_NAME" &>/dev/null 2>&1; then
  CURRENT_MODEL=$(az ml serverless-endpoint show -n "$ENDPOINT_NAME" -o json 2>/dev/null | jq -r '.model_id // .properties.modelSettings.modelId // "unknown"')
  if [[ "$CURRENT_MODEL" != "$MODEL_ID" && "$CURRENT_MODEL" != "unknown" ]]; then
    echo "WARNING: Endpoint '$ENDPOINT_NAME' exists with model '$CURRENT_MODEL' but requested '$MODEL_ID'."
    echo "         Delete and recreate to change models: az ml serverless-endpoint delete -n $ENDPOINT_NAME --yes"
    exit 1
  fi
  echo "Endpoint '$ENDPOINT_NAME' already exists with matching model."
else
  # Write endpoint YAML
  ENDPOINT_FILE=$(mktemp /tmp/endpoint-XXXXXX.yml)
  cat > "$ENDPOINT_FILE" <<EOF
name: ${ENDPOINT_NAME}
model_id: ${MODEL_ID}
EOF

  echo "==> Creating endpoint..."
  az ml serverless-endpoint create -f "$ENDPOINT_FILE"
  rm -f "$ENDPOINT_FILE"
fi

# ---------- Get credentials ----------
echo ""
echo "==> Endpoint credentials:"
CREDS=$(az ml serverless-endpoint get-credentials -n "$ENDPOINT_NAME" -o json 2>/dev/null)
ENDPOINT_URL=$(echo "$CREDS" | jq -r '.properties.inferenceEndpoint.uri // .uri // empty')
PRIMARY_KEY=$(echo "$CREDS" | jq -r '.properties.primaryKey // .primary_key // empty')

if [[ -z "$ENDPOINT_URL" ]]; then
  echo "Endpoint may still be provisioning. Check status with:"
  echo "  az ml serverless-endpoint show -n $ENDPOINT_NAME -o table"
  exit 0
fi

echo "  URL: $ENDPOINT_URL"
echo "  Key: ${PRIMARY_KEY:0:8}..."
echo ""

# ---------- Test ----------
echo "==> Testing endpoint..."
RESPONSE=$(curl -s -w "\n%{http_code}" "$ENDPOINT_URL/chat/completions" \
  -H "Authorization: Bearer $PRIMARY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":10}' 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "  Status: OK (200)"
  echo "  Response: $(echo "$BODY" | jq -r '.choices[0].message.content // .choices[0].text // "ok"' 2>/dev/null)"
else
  echo "  Status: $HTTP_CODE"
  echo "  Body: $BODY"
  echo "  (Endpoint may still be warming up — retry in a minute)"
fi

echo ""
echo "Foundry endpoint deployed. Use the URL and key above to call the model."
