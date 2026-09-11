// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package ollama

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestObservationFailureDoesNotAuthorizePull(t *testing.T) {
	for _, body := range []string{`{}`, `{"models":null}`, `{"models":[{`, `{"models":[{"name":"m:1"}]}`, `{"models":[],"models":[]}`} {
		t.Run(body, func(t *testing.T) {
			writes := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					writes++
				}
				fmt.Fprint(w, body)
			}))
			defer s.Close()
			_, err := NewModels(s.URL).Ensure(t.Context(), "m:1")
			if err == nil || errors.Is(err, ErrAbsent) || writes != 0 {
				t.Fatalf("failed observation authorized mutation: %v, %d", err, writes)
			}
		})
	}
	for _, code := range []int{401, 403, 404, 503} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code); fmt.Fprint(w, "secret-sentinel") }))
		_, err := NewModels(s.URL).Read(t.Context(), "m:1")
		s.Close()
		if err == nil || errors.Is(err, ErrAbsent) || strings.Contains(err.Error(), "secret-sentinel") {
			t.Fatalf("HTTP %d: %v", code, err)
		}
	}
}

func TestInterruptedPullResumesAndSubsequentEnsureHasNoEffects(t *testing.T) {
	installed := false
	pulls := 0
	m := Model{Name: "m:1", Digest: strings.Repeat("a", 64), Size: 42}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			models := []Model{}
			if installed {
				models = append(models, m)
			}
			json.MarshalWrite(w, struct {
				Models []Model `json:"models"`
			}{Models: models})
			return
		}
		pulls++
		fmt.Fprintln(w, `{"status":"pulling manifest"}`)
		if pulls == 1 {
			return
		}
		installed = true
		fmt.Fprintln(w, `{"status":"success"}`)
	}))
	defer s.Close()
	c := NewModels(s.URL)
	if _, err := c.Ensure(t.Context(), m.Name); err == nil {
		t.Fatal("partial stream reported success")
	}
	for range 2 {
		got, err := c.Ensure(t.Context(), m.Name)
		if err != nil || got != m {
			t.Fatalf("reconcile: %+v, %v", got, err)
		}
	}
	if pulls != 2 {
		t.Fatalf("unexpected pulls: %d", pulls)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := c.Read(ctx, m.Name); err == nil || errors.Is(err, ErrAbsent) {
		t.Fatalf("cancellation became absence: %v", err)
	}
}
