// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"os"
	"strings"
	"testing"
)

func TestFabricHarnessValidation(t *testing.T) {
	b, err := os.ReadFile("../../examples/fabric.yaml")
	if err != nil {
		t.Fatal(err)
	}
	d, err := Parse(strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	if d.Spec.Sandboxes[0].Agents[0].Runtime() != "fabric-deepagents" {
		t.Fatal("wrong runtime")
	}
	d.Spec.Sandboxes[0].Agents[0].Harness = "hermes"
	if err := d.Validate(); err != nil || d.Spec.Sandboxes[0].Agents[0].Runtime() != "fabric-hermes" {
		t.Fatal("Hermes runtime validation failed", err)
	}
	for _, pair := range [][2]string{{"fabric", ""}, {"fabric", "unknown"}, {"openclaw", "deepagents"}, {"unknown", ""}} {
		d.Spec.Sandboxes[0].Agents[0].Type = pair[0]
		d.Spec.Sandboxes[0].Agents[0].Harness = pair[1]
		if err := d.Validate(); err == nil {
			t.Fatalf("accepted unsupported combination %v", pair)
		}
	}
	for _, file := range []string{"../../examples/spark.yaml", "../../examples/managed-ollama.yaml"} {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		d, err := Parse(strings.NewReader(string(b)))
		if err != nil {
			t.Fatal(err)
		}
		d.Spec.Sandboxes[0].Agents[0].Type = "fabric"
		d.Spec.Sandboxes[0].Agents[0].Harness = "deepagents"
		if err := d.Validate(); err == nil || !strings.Contains(err.Error(), "Fabric slice requires external") {
			t.Fatal("accepted unqualified managed Fabric combination", err)
		}
	}
}
