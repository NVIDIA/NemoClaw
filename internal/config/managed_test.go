// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"bytes"
	"os"
	"testing"
)

func sparkDocument(t *testing.T) Document {
	t.Helper()
	b, err := os.ReadFile("../../examples/spark.yaml")
	if err != nil {
		t.Fatal(err)
	}
	d, err := Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestManagedSparkSchemaPreservesRoutesAndResolvedPins(t *testing.T) {
	d := sparkDocument(t)
	if d.Spec.InferenceProviders[0].Endpoint != "" || d.InferenceEndpoint() != "http://172.30.110.1:18888/v1" {
		t.Fatal("service endpoint leaked into public YAML")
	}
	if d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].ProviderRef != "qwen" {
		t.Fatal("providerRef changed")
	}
	b, err := d.YAML()
	if err != nil {
		t.Fatal(err)
	}
	read, err := Parse(bytes.NewReader(b))
	if err != nil || read.Digest() != d.Digest() {
		t.Fatal("resolved configuration did not round-trip", err)
	}
}

func TestManagedServiceRejectsAmbiguousAndUnsupportedConfiguration(t *testing.T) {
	for _, scenario := range []string{"endpoint", "credential", "mutable image", "model revision", "startup budget", "memory reserve", "backend", "route", "podman", "external gateway"} {
		t.Run(scenario, func(t *testing.T) {
			d := sparkDocument(t)
			p := &d.Spec.InferenceProviders[0]
			s := p.Service
			switch scenario {
			case "endpoint":
				p.Endpoint = "http://127.0.0.1:18888/v1"
			case "credential":
				p.Credential = &Credential{Env: "API_KEY"}
			case "mutable image":
				s.Image = "vllm/vllm-openai:latest"
			case "model revision":
				s.Model.Revision = "main"
			case "startup budget":
				s.Serving.StartupTimeoutSeconds = 120
			case "memory reserve":
				s.Memory.HostReserveGiB = 1
			case "backend":
				s.Backend = "shell"
			case "route":
				d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model = "unrelated"
			case "podman":
				d.Spec.Sandboxes[0].Runtime.Provider = "podman"
			case "external gateway":
				d.Spec.Gateway = Gateway{Management: "external", Endpoint: "http://127.0.0.1:17681"}
			}
			if err := d.Validate(); err == nil {
				t.Fatal("unsupported managed combination accepted")
			}
		})
	}
}

func TestVersionedDefaultsResolveBeforePlanning(t *testing.T) {
	d := sparkDocument(t)
	d.Spec.Gateway = Gateway{Management: "managed"}
	d.Spec.Sandboxes[0].Image = Image{}
	d.Spec.Sandboxes[0].Runtime = Runtime{}
	d.Spec.Sandboxes[0].Network = Network{}
	d.Defaults()
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if d.Spec.Gateway.Image != DefaultGatewayImage || d.Spec.Sandboxes[0].Image.Ref != DefaultAgentImage || d.Spec.Sandboxes[0].Network.Tier != "isolated" || d.Spec.Sandboxes[0].Runtime.Provider != "docker" {
		t.Fatal("versioned defaults differ")
	}
}
