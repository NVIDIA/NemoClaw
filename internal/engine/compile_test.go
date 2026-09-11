// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"encoding/json/v2"
	"os"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/config"
)

func TestManagedModelPrecedesRouteInTheCompiledGraph(t *testing.T) {
	b, err := os.ReadFile("../../examples/managed-ollama.yaml")
	if err != nil {
		t.Fatal(err)
	}
	d, err := config.Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	g := newGenerations()
	b, err = json.Marshal(Compile(d, g, "test"))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Resource map[string]map[string]struct {
			ServiceID  string   `json:"service_id"`
			DependsOn  []string `json:"depends_on"`
			Generation string   `json:"generation"`
		} `json:"resource"`
	}
	if err = json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Resource) != 6 || result.Resource["nemoclaw_ollama_model"]["inference"].ServiceID != "${nemoclaw_ollama.service.id}" || result.Resource["nemoclaw_route"]["primary"].DependsOn[0] != "nemoclaw_ollama_model.inference" || result.Resource["nemoclaw_ollama"]["service"].Generation != g["ollama"] {
		t.Fatal("model/service dependency or operation binding missing")
	}
}
