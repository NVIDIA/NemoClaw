#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -eu

MODEL="${OLLAMA_MODEL:?OLLAMA_MODEL required}"
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"

ollama serve &
SERVE_PID=$!

cleanup() {
  kill "${SERVE_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Waiting for Ollama API..."
for _ in $(seq 1 120); do
  if ollama list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Pull only when the model is not already in /root/.ollama (PVC, hostPath, or emptyDir).
if ollama show "${MODEL}" >/dev/null 2>&1; then
  echo "Model ${MODEL} already present — skipping pull"
else
  echo "Pulling model ${MODEL} (first time on this volume; may take several minutes)..."
  ollama pull "${MODEL}"
fi

echo "Ollama ready with model ${MODEL}"
wait "${SERVE_PID}"
