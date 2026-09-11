// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package spark

import (
	_ "embed"
	"encoding/json/v2"

	"github.com/NVIDIA/NemoClaw/internal/snapshot"
)

const Backend = "vllm-qwen38-spark-v1"
const RecipeRevision = "d03809008834124e80223c3482f2ddb59577a48f"
const PreparerSHA256 = "35da4312f5c9c442eea85445d6f6712c9bb3a3b7c6caccec412da57000b02475"
const PreparedFile = "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8"

//go:embed model.json
var modelJSON []byte

func ModelManifest() snapshot.Manifest {
	var m snapshot.Manifest
	if err := json.Unmarshal(modelJSON, &m); err != nil {
		panic(err)
	}
	return m
}
