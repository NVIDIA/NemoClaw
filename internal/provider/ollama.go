// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"errors"
	"maps"
	"strconv"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/ollama"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

var ollamaDefinitions = []oshell.Definition{
	{Kind: "ollama", Fields: []string{"name", "owner", "generation", "image", "network", "bind_address", "running"}, Mutable: []string{"running"}},
	{Kind: "ollama_model", Fields: []string{"service_id", "endpoint", "model"}, Mutable: []string{"model"}},
}

func serviceSpec(w oshell.Row) ollama.ServiceSpec {
	return ollama.ServiceSpec{Name: w["name"], Owner: w["owner"], Generation: w["generation"], Image: w["image"], Network: w["network"], BindAddress: w["bind_address"]}
}

func (r *Resource) readOllama(ctx context.Context, w oshell.Row) (oshell.Row, error) {
	if r.docker == nil {
		return nil, errors.New("managed Ollama engine is not configured")
	}
	got := maps.Clone(w)
	if r.definition.Kind == "ollama" {
		s, err := r.docker.Observe(ctx, serviceSpec(w))
		if err != nil || s == nil {
			return nil, err
		}
		if w["id"] != "" && w["id"] != s.ID {
			return nil, errors.New("Ollama physical identity changed")
		}
		got["id"] = s.ID
		got["running"] = strconv.FormatBool(s.Running)
		return got, nil
	}
	s, err := r.docker.Bound(ctx, w["service_id"], w["endpoint"])
	if err != nil {
		return nil, err
	}
	if !s.Running {
		return nil, errors.New("Ollama service is stopped; model inventory is unknown; no model mutation is authorized")
	}
	m, err := ollama.NewModels(w["endpoint"]).Read(ctx, w["model"])
	if errors.Is(err, ollama.ErrAbsent) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	got["id"] = w["service_id"] + "/model"
	got["digest"] = m.Digest
	return got, nil
}

func (r *Resource) applyOllama(ctx context.Context, w oshell.Row) (oshell.Row, error) {
	if r.docker == nil {
		return nil, errors.New("managed Ollama engine is not configured")
	}
	if r.definition.Kind == "ollama" {
		if w["running"] != "true" {
			return nil, errors.New("this slice declares Ollama running")
		}
		s, err := r.docker.Ensure(ctx, serviceSpec(w), w["id"])
		if err != nil {
			return nil, err
		}
		got := maps.Clone(w)
		got["id"] = s.ID
		got["running"] = strconv.FormatBool(s.Running)
		return got, nil
	}
	s, err := r.docker.Bound(ctx, w["service_id"], w["endpoint"])
	if err != nil {
		return nil, err
	}
	if !s.Running {
		return nil, errors.New("model installation requires the owned Ollama service running")
	}
	models := ollama.NewModels(w["endpoint"])
	// Initial server activation is a bounded read-only wait before the pull.
	ready, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ticks := time.Tick(200 * time.Millisecond)
	for {
		_, err = models.Read(ready, w["model"])
		if err == nil || errors.Is(err, ollama.ErrAbsent) {
			break
		}
		if !errors.Is(err, ollama.ErrStarting) {
			return nil, err
		}
		select {
		case <-ready.Done():
			return nil, errors.New("Ollama inventory did not become available; model installation was not attempted")
		case <-ticks:
		}
	}
	m, err := models.Ensure(ctx, w["model"])
	if err != nil {
		return nil, err
	}
	got := maps.Clone(w)
	got["id"] = w["service_id"] + "/model"
	got["digest"] = m.Digest
	return got, nil
}
