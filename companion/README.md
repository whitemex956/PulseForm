# PulseForm Companion (Windows)

Lets PulseForm react to the sound your PC is playing, without a microphone.

It captures the system's mixed output with **WASAPI loopback**, the documented Windows API for this. It measures the audio on your PC and sends only the measurements (levels, band energies, attacks, spectrum bars, waveform outline) to the PulseForm web app. It never records, stores or sends audio.

## Run

1. Build or download `pulseform-companion-windows-x64.exe` (ARM PCs: `-arm64`).
2. Run it. A console window shows which output device it is listening to.
3. In PulseForm, open **Audio source → Windows companion**.

```
pulseform-companion.exe              capture the default output device
pulseform-companion.exe --list       list output devices
pulseform-companion.exe --port 7531  change the localhost port
```

When the default device changes (for example, you plug in headphones), the companion restarts capture on the new device within a second.

## Build

Needs Go 1.22+ and nothing else (no cgo, no third-party modules).

```
cd companion
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/pulseform-companion-windows-x64.exe .
GOOS=windows GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o dist/pulseform-companion-windows-arm64.exe .
```

## Privacy and security

- It listens on `127.0.0.1` only, so other computers can't connect.
- It answers only pages served from this computer or your local network (`localhost` and private IP ranges), so a website on the internet can't read your audio analysis. Add other origins with `--allow-origin`.
- No audio leaves the process.

## What it can't hear

- Audio that Windows excludes from loopback capture, such as protected (DRM) playback through the protected media path. That audio arrives as silence. The companion does not work around it.
- Apps using exclusive-mode output, which bypasses the shared mix.

## Testing without Windows

`--test-wav file.wav` streams a WAV in real time through the same analysis and HTTP protocol. The automated tests use this on Linux. It checks the protocol and the web app integration, but it is **not** a test of WASAPI capture. That needs a real Windows PC.

`--dump-features file.wav` prints per-frame measurements. `tests/companion-parity.test.ts` uses it to confirm that the Go analysis matches the browser's analysis within 0.1%.

## Status

| Check | Status |
|---|---|
| Builds for Windows x64 and ARM64 | Done |
| Analysis matches the browser (parity test) | Passing |
| Protocol and app integration (WAV-fed, Linux) | Passing |
| WASAPI loopback on real Windows hardware | **Not yet verified.** Needs a run on a Windows PC |
