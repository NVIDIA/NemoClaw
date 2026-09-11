// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"errors"
	"net/url"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/ollama"
)

func ollamaSpec(d config.Document, g map[string]string) ollama.ServiceSpec {
	p := d.Spec.InferenceProviders[0]
	u, _ := url.Parse(p.Endpoint)
	return ollama.ServiceSpec{Name: d.Workspace() + "-ollama", Owner: d.Metadata.UID, Generation: g["ollama"], Image: p.Ollama.Image, Network: p.Ollama.Network, BindAddress: u.Host}
}

func observeOllama(ctx context.Context, d config.Document, g map[string]string, id string) (*ollama.Service, error) {
	if d.Spec.InferenceProviders[0].Ollama == nil {
		return nil, nil
	}
	c, err := ollama.NewDocker(d.Spec.InferenceProviders[0].Ollama.Engine)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	o, err := c.Observe(ctx, ollamaSpec(d, g))
	if err != nil {
		return nil, err
	}
	if id != "" && (o == nil || o.ID != id) {
		return nil, errors.New("Ollama binding is missing or changed; automatic replacement is forbidden")
	}
	return o, nil
}

func preflightOllama(ctx context.Context, d config.Document, g map[string]string, id string) error {
	if d.Spec.InferenceProviders[0].Ollama == nil {
		return nil
	}
	c, err := ollama.NewDocker(d.Spec.InferenceProviders[0].Ollama.Engine)
	if err != nil {
		return err
	}
	defer c.Close()
	return c.Preflight(ctx, ollamaSpec(d, g), id)
}
