// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestConfigurationRoundTrip(t *testing.T) {
	b, err := os.ReadFile("../../examples/local.yaml")
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
	if err != nil {
		t.Fatal(err)
	}
	if d.Digest() != again.Digest() {
		t.Fatal("round trip changed desired state")
	}
	if len(d.Workspace()) > 19 {
		t.Fatal("workspace exceeds OpenShell limit")
	}
}
func TestRejectUnsafeOrUnsupportedConfiguration(t *testing.T) {
	b, err := os.ReadFile("../../examples/local.yaml")
	if err != nil {
		t.Fatal(err)
	}
	base := string(b)
	cases := map[string]string{
		"unknown field":              strings.Replace(base, "management: external", "management: external\n    surprise: true", 1),
		"inline secret":              strings.Replace(base, "provider: openai", "provider: openai\n      apiKey: do-not-print-this", 1),
		"duplicate field":            strings.Replace(base, "name: local-agent", "name: local-agent\n  name: another", 1),
		"multiple documents":         base + "\n---\nkind: NemoClawConfig\n",
		"alias":                      strings.Replace(base, "name: local-agent", "name: &name local-agent", 1),
		"null":                       strings.Replace(base, "management: external", "management: null", 1),
		"mutable image":              strings.Replace(base, "@sha256:"+strings.Repeat("0", 64), ":latest", 1),
		"foreign provider reference": strings.Replace(base, "providerRef: local", "providerRef: foreign", 1),
		"template expression":        strings.Replace(base, "model: qwen3.5:0.8b", "model: '${file(\"secret\")}'", 1),
	}
	// Use the actual pinned image for the mutable-tag case.
	d, _ := Parse(strings.NewReader(base))
	cases["mutable image"] = strings.Replace(base, d.Spec.Sandboxes[0].Image.Ref, "ghcr.io/openclaw/openclaw:latest", 1)
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Parse(strings.NewReader(input))
			if err == nil {
				t.Fatal("accepted invalid config")
			}
			if strings.Contains(err.Error(), "do-not-print-this") {
				t.Fatal("parser leaked a secret")
			}
		})
	}
}
func TestEndpointRestrictions(t *testing.T) {
	for _, endpoint := range []string{"http://169.254.169.254/v1", "http://example.com/v1", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://[fe80::1]/v1", "http://0.0.0.0:1", "file:///etc/passwd", "https://metadata.google.internal/"} {
		if ValidateEndpoint(endpoint, false) == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
	for _, endpoint := range []string{"http://127.0.0.1:11434/v1", "http://172.20.0.1:11436/v1", "https://api.example.com/v1"} {
		if err := ValidateEndpoint(endpoint, false); err != nil {
			t.Error(err)
		}
	}
	if ValidateEndpoint("http://172.20.0.1:17671", true) == nil {
		t.Fatal("accepted plaintext remote gateway")
	}
}
