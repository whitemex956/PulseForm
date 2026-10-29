//go:build windows

package main

// WASAPI loopback capture in pure Go (no cgo): the documented way for an
// application to hear the system's mixed output on Windows. See
// https://learn.microsoft.com/windows/win32/coreaudio/loopback-recording
//
// Protected content: Windows excludes audio rendered through the protected media
// path from loopback capture. Such audio reaches this companion as silence, and
// the companion makes no attempt to circumvent that.

import (
	"errors"
	"fmt"
	"math"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

func mustGUID(s string) guid {
	var g guid
	var d4 [8]uint64
	_, err := fmt.Sscanf(s, "%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x", &g.Data1, &g.Data2, &g.Data3, &d4[0], &d4[1], &d4[2], &d4[3], &d4[4], &d4[5], &d4[6], &d4[7])
	if err != nil {
		panic(err)
	}
	for i := range d4 {
		g.Data4[i] = byte(d4[i])
	}
	return g
}

var (
	clsidMMDeviceEnumerator = mustGUID("BCDE0395-E52F-467C-8E3D-C4579291692E")
	iidIMMDeviceEnumerator  = mustGUID("A95664D2-9614-4F35-A746-DE8DB63617E6")
	iidIAudioClient         = mustGUID("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")
	iidIAudioCaptureClient  = mustGUID("C8ADBD64-E71E-48A0-A4DE-185C395CD317")
	subtypeFloat            = mustGUID("00000003-0000-0010-8000-00AA00389B71")
	pkeyFriendlyName        = struct {
		fmtid guid
		pid   uint32
	}{mustGUID("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14}

	ole32                = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoUninitialize   = ole32.NewProc("CoUninitialize")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")
	procPropVariantClear = ole32.NewProc("PropVariantClear")
)

const (
	eRender                  = 0
	eConsole                 = 0
	clsctxAll                = 0x17
	audclntShareModeShared   = 0
	audclntStreamFlagsLoop   = 0x00020000
	audclntBufferFlagsSilent = 0x2
	deviceStateActive        = 0x1
	stgmRead                 = 0
	vtLPWSTR                 = 31
	waveFormatPCM            = 1
	waveFormatIEEEFloat      = 3
	waveFormatExtensible     = 0xFFFE
)

type waveFormatEx struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	CbSize         uint16
}

type waveFormatExtensibleT struct {
	waveFormatEx
	ValidBits   uint16
	ChannelMask uint32
	SubFormat   guid
}

// comObj is a raw COM interface pointer; vtbl(i) returns method i.
type comObj uintptr

func (o comObj) vtbl(i int) uintptr {
	vt := *(*uintptr)(unsafe.Pointer(o))
	return *(*uintptr)(unsafe.Pointer(vt + uintptr(i)*unsafe.Sizeof(uintptr(0))))
}

func (o comObj) call(i int, args ...uintptr) error {
	hr, _, _ := syscall.SyscallN(o.vtbl(i), append([]uintptr{uintptr(o)}, args...)...)
	if int32(hr) < 0 {
		return hresult(uint32(hr))
	}
	return nil
}

func (o comObj) release() {
	if o != 0 {
		syscall.SyscallN(o.vtbl(2), uintptr(o))
	}
}

type hresult uint32

func (h hresult) Error() string {
	switch h {
	case 0x88890004:
		return "audio device was removed or changed (AUDCLNT_E_DEVICE_INVALIDATED)"
	case 0x8889000A:
		return "audio device is in use exclusively by another app (AUDCLNT_E_DEVICE_IN_USE)"
	case 0x80070005:
		return "access denied"
	}
	return fmt.Sprintf("HRESULT 0x%08X", uint32(h))
}

func coInit() error {
	hr, _, _ := procCoInitializeEx.Call(0, 0 /* COINIT_MULTITHREADED */)
	// S_OK, S_FALSE (already initialised) are both fine
	if int32(hr) < 0 && uint32(hr) != 0x80010106 {
		return hresult(uint32(hr))
	}
	return nil
}

func enumerator() (comObj, error) {
	var e comObj
	hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)), 0, clsctxAll, uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)), uintptr(unsafe.Pointer(&e)))
	if int32(hr) < 0 {
		return 0, hresult(uint32(hr))
	}
	return e, nil
}

func friendlyName(dev comObj) string {
	var store comObj
	if err := dev.call(4, stgmRead, uintptr(unsafe.Pointer(&store))); err != nil {
		return "Default output"
	}
	defer store.release()
	var pv [24]byte // PROPVARIANT (64-bit)
	if err := store.call(5, uintptr(unsafe.Pointer(&pkeyFriendlyName)), uintptr(unsafe.Pointer(&pv[0]))); err != nil {
		return "Default output"
	}
	defer procPropVariantClear.Call(uintptr(unsafe.Pointer(&pv[0])))
	if *(*uint16)(unsafe.Pointer(&pv[0])) != vtLPWSTR {
		return "Default output"
	}
	p := *(*uintptr)(unsafe.Pointer(&pv[8]))
	return utf16PtrToString(p)
}

func utf16PtrToString(p uintptr) string {
	if p == 0 {
		return ""
	}
	var s []uint16
	for i := uintptr(0); ; i += 2 {
		c := *(*uint16)(unsafe.Pointer(p + i))
		if c == 0 {
			break
		}
		s = append(s, c)
	}
	return syscall.UTF16ToString(s)
}

func listDevices() ([]string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := coInit(); err != nil {
		return nil, err
	}
	defer procCoUninitialize.Call()
	en, err := enumerator()
	if err != nil {
		return nil, err
	}
	defer en.release()
	var coll comObj
	if err := en.call(3, eRender, deviceStateActive, uintptr(unsafe.Pointer(&coll))); err != nil {
		return nil, err
	}
	defer coll.release()
	var n uint32
	if err := coll.call(3, uintptr(unsafe.Pointer(&n))); err != nil {
		return nil, err
	}
	out := []string{}
	for i := uint32(0); i < n; i++ {
		var dev comObj
		if coll.call(4, uintptr(i), uintptr(unsafe.Pointer(&dev))) == nil {
			out = append(out, friendlyName(dev))
			dev.release()
		}
	}
	return out, nil
}

type loopbackSource struct {
	name string
	rate float64
}

func newLoopbackSource() (Source, error) {
	// probe the default device once for its name and rate
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := coInit(); err != nil {
		return nil, err
	}
	defer procCoUninitialize.Call()
	en, err := enumerator()
	if err != nil {
		return nil, err
	}
	defer en.release()
	var dev comObj
	if err := en.call(4, eRender, eConsole, uintptr(unsafe.Pointer(&dev))); err != nil {
		return nil, errors.New("no audio output device found")
	}
	defer dev.release()
	var client comObj
	if err := dev.call(3, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&client))); err != nil {
		return nil, err
	}
	defer client.release()
	var wf *waveFormatEx
	if err := client.call(8, uintptr(unsafe.Pointer(&wf))); err != nil {
		return nil, err
	}
	rate := float64(wf.SamplesPerSec)
	procCoTaskMemFree.Call(uintptr(unsafe.Pointer(wf)))
	return &loopbackSource{name: friendlyName(dev), rate: rate}, nil
}

func (l *loopbackSource) Name() string        { return l.name }
func (l *loopbackSource) SampleRate() float64 { return l.rate }

// Run captures from the current default output device until it fails or stop closes.
func (l *loopbackSource) Run(push func([]float32), stop <-chan struct{}) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := coInit(); err != nil {
		return err
	}
	defer procCoUninitialize.Call()
	en, err := enumerator()
	if err != nil {
		return err
	}
	defer en.release()
	var dev comObj
	if err := en.call(4, eRender, eConsole, uintptr(unsafe.Pointer(&dev))); err != nil {
		return err
	}
	defer dev.release()
	l.name = friendlyName(dev)
	var client comObj
	if err := dev.call(3, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&client))); err != nil {
		return err
	}
	defer client.release()
	var wf *waveFormatEx
	if err := client.call(8, uintptr(unsafe.Pointer(&wf))); err != nil {
		return err
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(wf)))
	isFloat := wf.FormatTag == waveFormatIEEEFloat
	if wf.FormatTag == waveFormatExtensible {
		ext := (*waveFormatExtensibleT)(unsafe.Pointer(wf))
		isFloat = ext.SubFormat == subtypeFloat
	}
	ch := int(wf.Channels)
	bits := int(wf.BitsPerSample)
	l.rate = float64(wf.SamplesPerSec)
	const bufferDuration = 1_000_000 // 100 ms in 100-ns units
	if err := client.call(3, audclntShareModeShared, audclntStreamFlagsLoop, bufferDuration, 0, uintptr(unsafe.Pointer(wf)), 0); err != nil {
		return err
	}
	var capture comObj
	if err := client.call(14, uintptr(unsafe.Pointer(&iidIAudioCaptureClient)), uintptr(unsafe.Pointer(&capture))); err != nil {
		return err
	}
	defer capture.release()
	if err := client.call(10); err != nil { // Start
		return err
	}
	defer client.call(11) // Stop

	lastData := time.Now()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return nil
		case <-tick.C:
		}
		got := false
		for {
			var packet uint32
			if err := capture.call(5, uintptr(unsafe.Pointer(&packet))); err != nil {
				return err
			}
			if packet == 0 {
				break
			}
			var data uintptr
			var frames, flags uint32
			if err := capture.call(3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&frames)), uintptr(unsafe.Pointer(&flags)), 0, 0); err != nil {
				return err
			}
			buf := make([]float32, frames)
			if flags&audclntBufferFlagsSilent == 0 && data != 0 {
				convert(data, int(frames), ch, bits, isFloat, buf)
			}
			if err := capture.call(4, uintptr(frames)); err != nil {
				return err
			}
			push(buf)
			got = true
		}
		if got {
			lastData = time.Now()
		} else if gap := time.Since(lastData); gap > 30*time.Millisecond {
			// Windows delivers no packets while nothing plays: keep time moving with silence
			push(make([]float32, int(gap.Seconds()*l.rate)))
			lastData = time.Now()
		}
	}
}

// convert interleaved device samples to mono float32.
func convert(p uintptr, frames, ch, bits int, isFloat bool, out []float32) {
	bps := bits / 8
	for i := 0; i < frames; i++ {
		var s float64
		for c := 0; c < ch; c++ {
			a := p + uintptr((i*ch+c)*bps)
			switch {
			case isFloat && bits == 32:
				s += float64(*(*float32)(unsafe.Pointer(a)))
			case bits == 16:
				s += float64(*(*int16)(unsafe.Pointer(a))) / 32768
			case bits == 24:
				b := (*[3]byte)(unsafe.Pointer(a))
				v := int32(uint32(b[0])<<8|uint32(b[1])<<16|uint32(b[2])<<24) >> 8
				s += float64(v) / 8388608
			case bits == 32:
				s += float64(*(*int32)(unsafe.Pointer(a))) / 2147483648
			}
		}
		out[i] = float32(math.Max(-1, math.Min(1, s/float64(ch))))
	}
}
