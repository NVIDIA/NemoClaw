// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"maps"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/NVIDIA/NemoClaw/internal/provider"
)

type Target struct {
	Kind, Address string
	Values        oshell.Row
}

func Targets(d config.Document, generations map[string]string) []Target {
	w := d.Workspace()
	owner := d.Metadata.UID
	p := d.Spec.InferenceProviders[0]
	s := d.Spec.Sandboxes[0]
	a := s.Agents[0]
	credential := ""
	if p.Credential != nil {
		credential = p.Credential.Env
	}
	return []Target{
		{"workspace", "nemoclaw_workspace.deployment", oshell.Row{"name": w, "owner": owner, "generation": generations["workspace"]}},
		{"provider", "nemoclaw_provider.inference", oshell.Row{"workspace": w, "name": p.Name, "owner": owner, "generation": generations["provider"], "endpoint": p.Endpoint, "credential_env": credential}},
		{"route", "nemoclaw_route.primary", oshell.Row{"workspace": w, "name": "primary", "owner": owner, "generation": generations["workspace"], "provider_name": p.Name, "model": a.Inference.Routes[0].Overrides.Model}},
		{"sandbox", "nemoclaw_sandbox.agent", oshell.Row{"workspace": w, "name": s.Name, "owner": owner, "generation": generations["sandbox"], "image": s.Image.Ref, "agent_name": a.Name}},
	}
}

func newGenerations() map[string]string {
	m := map[string]string{}
	for _, kind := range []string{"workspace", "provider", "sandbox"} {
		b := make([]byte, 16)
		rand.Read(b)
		m[kind] = hex.EncodeToString(b)
	}
	return m
}

func Compile(d config.Document, generations map[string]string, version string) map[string]any {
	g := d.Spec.Gateway
	p := map[string]any{"endpoint": g.Endpoint}
	if g.Credential != nil {
		p["credential_env"] = g.Credential.Env
	}
	if g.TLS != nil {
		p["tls_ca_env"] = g.TLS.CA.Env
		p["tls_certificate_env"] = g.TLS.Certificate.Env
		p["tls_key_env"] = g.TLS.Key.Env
	}
	resources := map[string]any{}
	for i, t := range Targets(d, generations) {
		attrs := map[string]any{}
		for k, v := range maps.All(t.Values) {
			attrs[k] = v
		}
		name := []string{"deployment", "inference", "primary", "agent"}[i]
		if i > 0 {
			attrs["workspace"] = "${nemoclaw_workspace.deployment.name}"
		}
		if t.Kind == "route" {
			attrs["provider_name"] = "${nemoclaw_provider.inference.name}"
		}
		if t.Kind == "sandbox" {
			attrs["depends_on"] = []string{"nemoclaw_route.primary"}
		}
		attrs["lifecycle"] = map[string]any{"prevent_destroy": true}
		resources["nemoclaw_"+t.Kind] = map[string]any{name: attrs}
	}
	return map[string]any{
		"terraform": map[string]any{"required_version": "= 1.12.6", "required_providers": map[string]any{"nemoclaw": map[string]any{"source": provider.Address, "version": "= " + version}}},
		"provider":  map[string]any{"nemoclaw": p}, "resource": resources,
	}
}

func (t Target) String() string { return fmt.Sprintf("%s %s", t.Kind, t.Values["name"]) }
