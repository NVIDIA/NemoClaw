// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestManagedOllamaRequiresExplicitSafeBindings(t *testing.T) {
	b, err := os.ReadFile("../../examples/managed-ollama.yaml")
	if err != nil {
		t.Fatal(err)
	}
	d, err := Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := d.YAML()
	if err != nil {
		t.Fatal(err)
	}
	again, err := Parse(bytes.NewReader(out))
	if err != nil || again.Digest() != d.Digest() {
		t.Fatalf("managed configuration round trip: %v", err)
	}
	for name, change := range map[string][2]string{
		"remote engine":      {"unix:///var/run/docker.sock", "tcp://127.0.0.1:2375"},
		"expression":         {"unix:///var/run/docker.sock", "unix:///${path.cwd}/sock"},
		"wildcard binding":   {"172.20.0.1:11436", "0.0.0.0:11436"},
		"implicit port":      {"172.20.0.1:11436", "172.20.0.1"},
		"noncanonical model": {"qwen3:0.6b", "qwen3"},
		"mutable image":      {"ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba", "ollama/ollama:latest"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(strings.Replace(string(b), change[0], change[1], 1))); err == nil {
				t.Fatal("unsafe managed configuration accepted")
			}
		})
	}
}
