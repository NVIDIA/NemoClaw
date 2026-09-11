// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrAbsent is returned only after a complete successful inventory response.
var ErrAbsent = errors.New("model is confirmed absent")

type Model struct {
	Name   string `json:"name"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

type Models struct {
	Endpoint string
	HTTP     *http.Client
}

func NewModels(endpoint string) Models {
	return Models{Endpoint: strings.TrimSuffix(endpoint, "/v1"), HTTP: &http.Client{
		Transport:     &http.Transport{Proxy: nil, ResponseHeaderTimeout: 30 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect forbidden") },
	}}
}

func (m Models) request(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	q, err := http.NewRequestWithContext(ctx, method, m.Endpoint+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("invalid Ollama request")
	}
	q.Header.Set("Content-Type", "application/json")
	r, err := m.HTTP.Do(q)
	if err != nil {
		return nil, errors.New("Ollama transport failed; model inventory is unknown")
	}
	if r.StatusCode != http.StatusOK {
		r.Body.Close()
		return nil, errors.New("Ollama request rejected; model inventory is unknown")
	}
	return r, nil
}

func (m Models) Read(ctx context.Context, name string) (Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	r, err := m.request(ctx, http.MethodGet, "/api/tags", nil)
	if err != nil {
		return Model{}, err
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20+1))
	var result struct {
		Models *[]Model `json:"models"`
	}
	if err != nil || len(b) > 1<<20 || json.Unmarshal(b, &result) != nil || result.Models == nil {
		return Model{}, errors.New("incomplete Ollama inventory; absence is unconfirmed")
	}
	seen := map[string]bool{}
	var found Model
	for _, model := range *result.Models {
		digest, err := hex.DecodeString(model.Digest)
		if model.Name == "" || err != nil || len(digest) != 32 || model.Size <= 0 || seen[model.Name] {
			return Model{}, errors.New("incomplete or ambiguous Ollama model metadata")
		}
		seen[model.Name] = true
		if model.Name == name {
			found = model
		}
	}
	if found.Name == "" {
		return Model{}, ErrAbsent
	}
	return found, nil
}

// Ensure asks Ollama to resume its content-addressed pull only after inventory
// confirms the model is missing. It never deletes existing models or retries a
// mutation within this call. A lost/partial stream requires another apply.
func (m Models) Ensure(ctx context.Context, name string) (Model, error) {
	model, err := m.Read(ctx, name)
	if err == nil || !errors.Is(err, ErrAbsent) {
		return model, err
	}
	b, err := json.Marshal(struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}{Model: name, Stream: true})
	if err != nil {
		return Model{}, err
	}
	r, err := m.request(ctx, http.MethodPost, "/api/pull", b)
	if err != nil {
		return Model{}, err
	}
	defer r.Body.Close()
	s := bufio.NewScanner(r.Body)
	s.Buffer(make([]byte, 4096), 1<<20)
	complete := false
	for s.Scan() {
		var event struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		if json.Unmarshal(s.Bytes(), &event) != nil || event.Error != "" || event.Status == "" || complete {
			return Model{}, errors.New("Ollama pull response is invalid or failed; retained artifacts require reconciliation")
		}
		complete = event.Status == "success"
	}
	if s.Err() != nil || !complete {
		return Model{}, errors.New("Ollama pull interrupted; retain storage and reapply the same configuration")
	}
	return m.Read(ctx, name)
}
