// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInterruptedBodyResumesWithinOneEnsure(t *testing.T) {
	m := manifest("right")
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Content-Length", "5")
			fmt.Fprint(w, "ri")
			return
		}
		if r.Header.Get("Range") != "bytes=2-" {
			t.Errorf("unsafe retry range %s", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Range", "bytes 2-4/5")
		w.WriteHeader(http.StatusPartialContent)
		fmt.Fprint(w, "ght")
	}))
	defer s.Close()
	var evidence []string
	_, err := (Client{BaseURL: s.URL, HTTP: s.Client(), ResumeAttempts: 4}).Ensure(t.Context(), t.TempDir(), m, func(s string) { evidence = append(evidence, s) })
	if err != nil || calls.Load() != 2 {
		t.Fatal("resumable read did not recover", err, calls.Load())
	}
	if len(evidence) != 2 || !strings.Contains(evidence[1], "attempt 2 of 4") {
		t.Fatal("retry attempt evidence missing")
	}
}

func TestResumptionIsBoundedAndDoesNotRetryAuthentication(t *testing.T) {
	for _, authentication := range []bool{false, true} {
		t.Run(strconv.FormatBool(authentication), func(t *testing.T) {
			var calls atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := int(calls.Add(1))
				if authentication {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if n > 1 {
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-9/10", n-1))
					w.WriteHeader(http.StatusPartialContent)
				}
				fmt.Fprint(w, "x")
			}))
			defer s.Close()
			_, err := (Client{BaseURL: s.URL, HTTP: s.Client(), ResumeAttempts: 4}).Ensure(t.Context(), t.TempDir(), manifest("xxxxxxxxxx"), nil)
			want := int32(4)
			if authentication {
				want = 1
			}
			if err == nil || calls.Load() != want {
				t.Fatalf("unbounded or unsafe retries: %d %v", calls.Load(), err)
			}
		})
	}
}
