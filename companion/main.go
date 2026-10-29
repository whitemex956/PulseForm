// PulseForm Windows audio companion.
//
// Captures the PC's sound output with WASAPI loopback (the standard, documented
// Windows API for this), measures it on this machine, and serves ONLY the
// derived measurements to the PulseForm web app over http://127.0.0.1.
// It never records, stores or sends raw audio.
//
// Audio that Windows or an app marks as protected (for example DRM video
// playback through the protected media path) is excluded from loopback by the
// OS and stays silent here. The companion does not try to work around that.
//
//	pulseform-companion.exe                 capture the default output device
//	pulseform-companion.exe --list          list output devices
//	pulseform-companion.exe --test-wav f    stream a WAV file in real time (testing)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Source delivers mono float32 PCM in real time.
type Source interface {
	Name() string
	SampleRate() float64
	// Run blocks, calling push for every captured buffer, until stop is closed.
	Run(push func([]float32), stop <-chan struct{}) error
}

type frameMsg struct {
	Type string `json:"type"`
	// Seconds between the newest analysed sample and the moment of sending.
	Age float64 `json:"age"`
	Seq uint64  `json:"seq"`
	Measurement
	Bands []float64 `json:"bands"`
	Wave  []float32 `json:"wave"`
}

type hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	status  map[string]any
}

func (h *hub) add() chan []byte {
	ch := make(chan []byte, 64)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) remove(ch chan []byte) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
}

func (h *hub) send(b []byte) {
	h.mu.Lock()
	for ch := range h.clients {
		select {
		case ch <- b:
		default: // slow client: drop the frame rather than block capture
		}
	}
	h.mu.Unlock()
}

func (h *hub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// allowedOrigin accepts the PulseForm app served from this machine or the local
// network. Pages on the public internet cannot read your audio analysis.
func allowedOrigin(origin string, extra []string) bool {
	if origin == "" {
		return false
	}
	for _, o := range extra {
		if o == origin {
			return true
		}
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func main() {
	port := flag.Int("port", 7531, "localhost port the web app connects to")
	testWav := flag.String("test-wav", "", "stream this WAV file instead of capturing (testing)")
	list := flag.Bool("list", false, "list output devices and exit")
	allow := flag.String("allow-origin", "", "extra comma-separated origins allowed to connect")
	dump := flag.String("dump-features", "", "print per-frame measurements of a WAV as JSON and exit (parity tests)")
	flag.Parse()
	if *dump != "" {
		dumpFeatures(*dump)
		return
	}
	extra := []string{}
	if *allow != "" {
		extra = strings.Split(*allow, ",")
	}

	if *list {
		names, err := listDevices()
		if err != nil {
			log.Fatal(err)
		}
		for _, n := range names {
			fmt.Println(n)
		}
		return
	}

	var src Source
	var err error
	if *testWav != "" {
		src, err = newWavSource(*testWav)
	} else {
		src, err = newLoopbackSource()
	}
	if err != nil {
		log.Fatalf("audio capture could not start: %v", err)
	}

	h := &hub{clients: map[chan []byte]struct{}{}, status: map[string]any{}}
	h.status["device"] = src.Name()
	h.status["sampleRate"] = src.SampleRate()
	h.status["version"] = "0.1.0"

	go runAnalysis(src, h)

	mux := http.NewServeMux()
	cors := func(w http.ResponseWriter, r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if !allowedOrigin(origin, extra) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return false
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		// Private Network Access: lets an https page on the LAN reach this localhost service
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return false
		}
		return true
	}
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if !cors(w, r) {
			return
		}
		h.mu.Lock()
		st := map[string]any{"clients": len(h.clients)}
		for k, v := range h.status {
			st[k] = v
		}
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(st)
	})
	mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		if !cors(w, r) {
			return
		}
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		ch := h.add()
		defer h.remove(ch)
		hello, _ := json.Marshal(map[string]any{"type": "hello", "device": src.Name(), "sampleRate": src.SampleRate()})
		fmt.Fprintf(w, "data: %s\n\n", hello)
		fl.Flush()
		ping := time.NewTicker(10 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case b := <-ch:
				fmt.Fprintf(w, "data: %s\n\n", b)
				fl.Flush()
			case <-ping.C:
				fmt.Fprint(w, ": ping\n\n")
				fl.Flush()
			}
		}
	})

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("PulseForm companion: capturing %q at %.0f Hz", src.Name(), src.SampleRate())
	log.Printf("Open PulseForm and choose Audio source → Windows companion (listening on %s)", addr)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
		os.Exit(1)
	}
}

// runAnalysis keeps the capture running for the life of the process, restarting
// it if the device changes or disappears.
func runAnalysis(src Source, h *hub) {
	for {
		ex := NewExtractor(src.SampleRate())
		ring := make([]float32, FrameSize)
		frame := make([]float32, FrameSize)
		write, sinceHop := 0, 0
		var seq uint64
		var wave []float32
		var blkMin, blkMax float32 = 1, -1
		blkN := 0
		lastSample := time.Now()
		stop := make(chan struct{})
		err := src.Run(func(buf []float32) {
			lastSample = time.Now()
			for _, s := range buf {
				ring[write] = s
				write = (write + 1) % FrameSize
				if s < blkMin {
					blkMin = s
				}
				if s > blkMax {
					blkMax = s
				}
				blkN++
				if blkN == 128 {
					wave = append(wave, blkMin, blkMax)
					blkMin, blkMax, blkN = 1, -1, 0
				}
				sinceHop++
				if sinceHop >= HopSize {
					sinceHop -= HopSize
					copy(frame, ring[write:])
					copy(frame[FrameSize-write:], ring[:write])
					m := ex.Process(frame, HopSize)
					if h.count() > 0 {
						msg := frameMsg{Type: "frame", Age: time.Since(lastSample).Seconds(), Seq: seq, Measurement: m, Bands: ex.Bands(), Wave: wave}
						if b, err := json.Marshal(msg); err == nil {
							h.send(b)
						}
					}
					wave = wave[:0]
					seq++
				}
			}
		}, stop)
		h.mu.Lock()
		h.status["error"] = fmt.Sprint(err)
		h.mu.Unlock()
		log.Printf("capture stopped (%v); restarting in 1 s", err)
		time.Sleep(time.Second)
	}
}

// dumpFeatures analyses a WAV exactly like the offline browser analysis
// (frames centred by padding half a window) and prints the measurements.
func dumpFeatures(path string) {
	mono, rate, err := readWav(path)
	if err != nil {
		log.Fatal(err)
	}
	padded := make([]float32, len(mono)+FrameSize)
	copy(padded[FrameSize/2:], mono)
	count := len(mono) / HopSize
	ex := NewExtractor(rate)
	out := make([]Measurement, 0, count)
	for f := 0; f < count; f++ {
		out = append(out, ex.Process(padded[f*HopSize:f*HopSize+FrameSize], HopSize))
	}
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
