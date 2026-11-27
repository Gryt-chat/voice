# Own video transport in the browser (GRYT-2261)

Shared windows go to the SFU's video hub over WebTransport instead of WebRTC. It's the same hub the Rust client uses over UDP, so a browser, Electron and the Rust client see each other's shares. It's off unless `gryt.ownVideoTransport` is `1`, and it only starts when the SFU offers `audio_transport.video`.

## What goes over the wire

The same bytes as the Rust client. `videoWire.ts` is client-rs `video_wire.rs` byte for byte, and the check script uses the same vectors:

- A piece is a 16-byte clear header (version 2, keyframe flag, track, codec, frame, piece, pieces, temporal layer, a µs capture stamp) and up to 1100 bytes of one encoded frame.
- Controls are version 3: keyframe, resend (up to 32 frame/piece pairs) and layers (the top temporal layer this viewer takes).
- The SFU puts the sender's id in front of everything it forwards, and 0 in front of what it sends itself.

Over WebTransport there's no seal. QUIC already encrypts and authenticates, which is why the UDP session needs `video_seal` and this one doesn't.

Track 1 and up are shared windows, 0 is left for a camera, and the top bit is a share's sound. A sender announces a window as `gryt-video:<track>`, like client-rs does. Every member's first window is `gryt-video:1`, so a viewer looks it up together with the user: `videoStreams["gryt-video:1@<user id>"]`, from `hubStreamId`.

## Sending

`videoSend.ts`: `MediaStreamTrackProcessor` hands frames to a WebCodecs `VideoEncoder`. It takes the first config the browser supports, in this order: hardware before software, `L1T3` before `L1T2` before none. Output is H.264 constrained baseline in Annex B, which is what client-rs's VideoToolbox and Media Foundation decoders take. In Electron 40 on macOS that's VideoToolbox with `L1T2`.

- A credit bucket holds the frame rate, so a source running at the target rate loses nothing to jitter.
- A frame is skipped when the encoder still has two queued.
- A keyframe goes out on start, after a pause, and when the SFU passes on a viewer's request.
- Frame numbers run per track, and pieces go out as datagrams with nothing held back.

Safari (18 and up) has `MediaStreamTrackProcessor` and `VideoTrackGenerator` only in a dedicated worker, so `frameTrack.ts` runs them in one and passes the frames over. The send side gets a clone of the track, so the local preview keeps playing. Everything else is the same code as Chromium. Safari has no `L1T3`, so it sends `L1T2`. Safari before 18 has WebCodecs but no worker processor; `videoTransportSupported()` asks a worker once, so those stay on WebRTC video.

AV1 has a codec byte and a decoder entry, but nothing sends it yet. Rust only decodes H.264.

## Receiving

`videoAssembly.ts` is `video_assembly.rs`:

- A frame goes out when its last piece lands, in order.
- A hole is asked for again after 15 ms, and then every 40 ms.
- A frame still broken after 250 ms is dropped, and the stream waits for a keyframe, asking at most once per 300 ms.

`videoReceive.ts` decodes with `VideoDecoder` and writes the pictures into a `MediaStreamTrackGenerator`. Tiles get a normal `MediaStream` and draw it like a WebRTC one. When the track is still busy with the last picture, the new one is dropped rather than queued.

## Viewer demand

A tile that isn't drawn (0×0, from `drawnVideoSize`) sends `layers none`, and the SFU stops forwarding that stream. Drawn again, it sends `layers all` and a keyframe request. That part works on the SFUs we have now.

The `demand` control (type 4) tells the sender what its viewers draw. The bytes are in client-rs's `SFU.md`, and the Rust SFU and the Rust client speak it too:

- The viewer sends width, height and fps, its loss, and its queueing delay in 4 ms steps, when what it draws changes and once a second while it draws.
- The SFU sends the sender the max size and fps over its viewers, the number of watchers, and the worst loss and delay.

The browser pauses with no watchers, and caps the height (rounded up to 360/540/720/1080/1440/2160) and the frame rate. The Rust client sends `0xffff` for all three, so it never caps a sender. The Go SFU drops type 4 as malformed, so nothing happens there.

## Congestion control: what was chosen

It's the biggest risk, and the first version is simple.

1. **Viewer side, works now.** Each viewer counts how many pieces it had to ask for again. Over 5% for 2 s drops one temporal layer (`layers` with a lower top), and under 1% for 5 s brings it back. The SFU already filters on this. It halves or quarters that viewer's frame rate without touching anyone else's.
2. **Sender side, AIMD.** The target bitrate drops to 85% of what actually went out on a bad second, holds for 1.5 s, then grows 8% plus 50 kbps every 500 ms up to the user's ceiling. The first cut of a bad spell with viewer loss over 10% goes half the loss deeper, so a full link gets below its limit in a second or two. It is split across windows by their ceilings. A bad second is any of these:
   - viewer-reported loss over 5%, or queueing over 60 ms (from `demand`, so it needs the Rust SFU)
   - the connection's own QUIC loss over 5%, a round trip 60 ms over its best, or datagrams the browser dropped, when `WebTransport.getStats()` exists

   The viewer's queueing delay is how far each frame arrives behind the quickest of the last 5 to 10 s, from its capture stamp, so the two clocks' offset cancels (`QueueDelay`). `video_rate.rs` in client-rs is the same controller, number for number, for the Rust sender.

What was tried and dropped:

- Chromium 144 (Electron 40) has no `WebTransport.getStats()`.
- The datagram writer's `desiredSize` stays at 1 whatever `outgoingHighWaterMark` is set to, so it says nothing about the queue.
- Write promises resolve straight away.

So in Electron the viewers' `demand` is the sender's only congestion signal, and it needs the Rust SFU.

## Not done

- A share's sound (`AUDIO_TRACK`) still goes over WebRTC. Rust viewers don't hear an Electron share yet.
- Camera on track 0.
- The WebSocket fallback when UDP is blocked. The audio transport has `/audio-ws`, and video would need a `/video-ws`.
- Work happens on the main thread. Moving the session and codecs into a worker would take React's jank out of the latency.
- The capture stamp is the sender's wall clock in µs. Rust stamps the voice server's clock, so latency read across two machines is off by their offset.

## Measured

1080p60 synthetic canvas (moving blocks, the time drawn as 32 cells along the top), shared from one Electron 40 window and watched in another on the same macOS machine. Go SFU with `VIDEO_TRANSPORT=true`, TS server, everything on one machine. Latency is capture to the frame the viewer's `<video>` presents (`requestVideoFrameCallback`), read off the pixels. The source alone, drawn locally, shows at 28 ms on the same scale.

| | size | sent fps | shown fps | p50 | p95 |
|---|---|---|---|---|---|
| Video hub | 1920×1080, ~8.6 Mbit/s | 55 of 56 | 49 | 37 ms | 44 ms |
| Video hub, held to WebRTC's size | 640×360, 1.2 Mbit/s | 57 of 57 | 53 | 31 ms | 39 ms |
| WebRTC | 640×360, 1.3 Mbit/s | 55–58 | 32–49 | 36–39 ms | 50–52 ms |

WebRTC's bandwidth estimate stayed at about 2.2 Mbit/s with no network in between, so its budget kept the share at 360p for the whole run. The hub has no such estimate yet and sends what the user picked. The engine's own capture-to-decoded figure on the hub is 8 ms.

Electron to the Rust client, on the same hub (UDP on the Rust side): 1080p decoded at 54–56 fps.

On the Rust SFU (WebTransport `/video` into the same hub), the session was driven straight from the page, because the web engine still waits for a WebRTC connection the Rust SFU doesn't offer. 1080p60 went out at 60 fps in and 59.6 sent. It was shown at 55 fps in Electron (p50 37 ms, p95 44 ms) and decoded at 60.6 fps in the Rust client over UDP.
