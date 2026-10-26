package main

import (
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestH2CAgainstStub runs the user model over h2c:// against the stub served as HTTP/2 cleartext only (prior
// knowledge), with a short idle timeout so GOAWAY + reconnect paths get exercised.
func TestH2CAgainstStub(t *testing.T) {
	st := &stub{r: rand.New(rand.NewPCG(3, 4))}
	var h1, h2 atomic.Int64
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 {
			h2.Add(1)
		} else {
			h1.Add(1)
		}
		st.ServeHTTP(w, r)
	})
	srv := httptest.NewUnstartedServer(h)
	srv.Config.Protocols = new(http.Protocols)
	srv.Config.Protocols.SetUnencryptedHTTP2(true)
	srv.Config.IdleTimeout = 500 * time.Millisecond
	srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		if s == http.StateNew {
			st.conns.Add(1)
		}
	}
	srv.Start()
	defer srv.Close()

	res, err := runBox(runConfig{target: strings.Replace(srv.URL, "http://", "h2c://", 1), users: 100, ramp: 2 * time.Second,
		measure: 10 * time.Second, tail: time.Second, secret: "s", runID: "h2c", articles: 10000, thinkScale: 0.02,
		t0: time.Now().Add(200 * time.Millisecond)})
	if err != nil {
		t.Fatal(err)
	}
	m := mergeResults([]*BoxResult{res})
	t.Logf("h2 requests %d, h1 requests %d, connections %d, error rate %.4f", h2.Load(), h1.Load(), st.conns.Load(), m.Overall.ErrorRate)
	if h1.Load() > 0 || h2.Load() == 0 {
		t.Errorf("want only HTTP/2 requests: h2 %d, h1 %d", h2.Load(), h1.Load())
	}
	if m.Overall.ErrorRate > 0 {
		t.Errorf("errors: %v %q", m.Overall.ErrorClasses, m.Overall.ErrorExample)
	}
	if st.bad.Load() > 0 {
		t.Errorf("%d malformed/unrouted requests", st.bad.Load())
	}
}
