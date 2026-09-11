// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package spark

import (
	"fmt"
	"math"
	"strconv"
)

func (s Service) Arguments(modelDir string, total int64) []string {
	v := s.Serving
	u := math.Floor(float64(s.GPUBytes())/float64(total)*1000) / 1000
	a := []string{"-m", "vllm.entrypoints.openai.api_server", "--model", modelDir,
		"--served-model-name", ModelName, "--host", "0.0.0.0", "--port", strconv.Itoa(v.Port),
		"--tensor-parallel-size", "1", "--gpu-memory-utilization", fmt.Sprintf("%.3f", u),
		"--max-num-seqs", strconv.Itoa(v.MaxSequences), "--max-num-batched-tokens", strconv.Itoa(v.BatchTokens),
		"--max-model-len", strconv.Itoa(v.ContextTokens), "--kv-cache-dtype", "fp8", "--mamba-ssm-cache-dtype", "bfloat16",
		"--load-format", "safetensors", "--safetensors-load-strategy", "lazy", "--enable-chunked-prefill",
		"--reasoning-parser", "qwen3", "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_coder",
		"--distributed-executor-backend", "mp", "--compilation-config", `{"mode":0,"cudagraph_mode":"FULL_DECODE_ONLY","cudagraph_capture_sizes":[1,2,4,8]}`}
	if v.SpeculativeTokens > 0 {
		a = append(a, "--speculative-config", fmt.Sprintf(`{"method":"mtp","num_speculative_tokens":%d}`, v.SpeculativeTokens))
	}
	return a
}
