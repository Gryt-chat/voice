# How much video each sender sends

Design for GRYT-1321, and the groundwork GRYT-1335 (several shared windows) needs. Every number
here was measured on 2026-09-24 with the scripts in [`bandwidth-allocation/`](bandwidth-allocation/),
against an SFU built from `Gryt-chat/sfu` main (`fe1afde`). How to run them is at the end.

## Recommendation

Split the decision. Viewers say how big they draw each video. The SFU keeps the largest size per
track and tells the sender. The sender picks a size, frame rate and bitrate for each of its
streams, since it's the only one that can see its own upload.

**Stage 1** saves bandwidth on its own:

1. Each viewer reports, per remote video track, the size it draws it at in device pixels, and 0
   when nobody can see it. It sends this to the SFU over the SFU websocket it already has.
2. The SFU keeps the largest report per track, stops forwarding to viewers who reported 0, and
   sends the sender a `video_wanted` message when the largest changes.
3. The sender sets `scaleResolutionDownBy` to the smallest rung that covers the wanted size, and
   a `maxBitrate` to go with it. Without the bitrate cap a smaller camera costs the same bytes.
   It pauses a stream after 10 s of nobody watching and resumes it as soon as somebody does. A
   watchdog checks the resume, because a resumed share can stay frozen.

That's three repos: the SFU (roughly 120 lines plus tests, review-required), `@gryt/voice` and
the client. Stage 2 adds the budget split across one person's streams. Stage 3 is dynamic SFU
slots for several windows.

The numbers behind it:

| What | Measured |
|---|---|
| Camera alone, 1080p source, scaled to 1080p / 720p / 360p | 2,548 / 2,506 / 2,566 kbps, so scaling alone saves nothing |
| Text share, scaled to 1080p / 720p / 360p | 772–839 / 424–429 / 184–189 kbps |
| Motion share, scaled to 1080p / 720p / 360p | 11,829 / 7,571 / 4,410 kbps |
| Camera, share and mic, video paused | 64–65 kbps on the wire, which is the mic |
| Estimate falling to a new cap | 0.8 s to get under 2 Mbps, 3.8 s to get under 0.8 Mbps |
| Estimate after the cap lifts | 0.67 → 5.1 Mbps within 2 s |
| `setParameters` size change, camera | first new-size frame at the viewer 22–97 ms later, one keyframe, no freeze |
| `setParameters` step up, share | first 1080p frame 468–1,003 ms later, a 0.4–0.9 s freeze |
| Resume after 25 s paused, mic running | share still frozen 5–30 s later in 7 of 7 plain resumes; with a watchdog, back in 3 s |
| What the SFU does with viewers' congestion feedback | reads none of it, and drops about 16 TWCC packets a second per viewer |

## What Gryt does today

**Sender.** One encoding per stream. `controls.tsx` in the client gives the share a `maxBitrate`
of 50 Mbps at the default "native" quality (`estimateBitrate` returns null for it), plus
`priority: "high"`, `maintain-resolution` and 30 fps. The camera gets no bitrate cap,
`priority: "low"` while a share is running, and `maintain-framerate`. `scalabilityMode` is only
applied when the codec isn't H.264, and H.264 is the default, so the temporal layers picked in
`ScreenSharePickerModal.tsx` do nothing for most people. The mic is capped at 64 kbps since
voice#64.

**SFU.** `pion.NewAPI` gets no interceptor registry, so pion registers its defaults: NACK, RTCP
reports, stats, and a TWCC sender interceptor that writes transport-wide feedback for the media
the SFU receives. That feedback is what gives the sender's Chrome its send estimate. Nothing
estimates the other direction. `relayReceiverRTCP` reads each viewer's RTCP and passes PLI and
FIR back to the sender. Everything else is dropped. `LayerForwarder` can drop temporal layers per
viewer through `set_layer`, which no client sends. Every client gets four fixed receive slots in
`peer.go`: mic, camera, share video, share audio.

**Viewer.** `VideoCard` draws a camera with `object-fit: cover` and a share with `contain`. A
share is pinned full width above the participant strip. A tile can be focused
(`FocusedVideoView`) or popped out into its own window (`popoutVideo.ts`, via `window.open`).
Since GRYT-1390 the thread panel shares the width instead of covering it, so opening a thread
shrinks every tile.

## Measurements

### The rig

- One sender and one viewer, each a headless Chrome 153 page in its own browser context, on an
  M5 Pro Mac. H.264 was encoded by VideoToolbox, and by OpenH264 at 480×270, which Chrome
  switched to by itself. VP9 was libvpx.
- The page speaks the SFU protocol directly (`client_join`, offer, answer, candidates) and
  publishes on the fixed slots the way `publishOnSfuSlot` does. The SFU gets a fake server
  registration on its control port and runs with `SFU_REQUIRE_CLIENT_TOKEN=false`.
- The sources are canvases. The camera is a moving head on a gradient with per-frame noise on
  top, since noise is what makes a real webcam expensive. Chrome's fake camera tops out at
  1280×720 and 20 fps. The share is either a code editor scrolling a line a second with a
  blinking caret ("text"), or 40 moving circles on a shifting gradient ("motion").
- The shaper is a user-space UDP relay in `lib.mjs`. I didn't use `dnctl`/`pfctl` because they
  change the Mac's packet filter and need root. The relay needs neither and dies with the
  script. The sender's page points the SFU's candidates at it and sends the SFU none of its own,
  so the SFU only ever sees the sender through the relay. It's a drop-tail link at a set rate,
  with a 150 ms buffer and 15 ms each way (30 ms RTT measured).

### Bytes at each size

Scaled with `scaleResolutionDownBy` on a 1920×1080, 30 fps source, without renegotiating.
Averaged over 15 s after 10 s to settle, on an unshaped link.

**Camera alone** (`sizes-camera-h264.json`):

| Scale | Sent at | kbps | Chrome's target | Encode per frame |
|---|---|---|---|---|
| 1 | 1920×1080 | 2,548 | 2,500 | 5.41 ms |
| 1.5 | 1280×720 | 2,506 | 2,500 | 3.68 ms |
| 3 | 640×360 | 2,566 | 2,500 | 1.96 ms |

Chrome sets the camera's target from the capture size and doesn't move it when the output
shrinks. The encoder fills whatever target it gets, so a 360p camera costs the same 2.5 Mbps as a
1080p one. Scaling only saves encode time. A size change has to carry a `maxBitrate` too.

**Text share with the camera running** (two runs, `sizes-both-text-h264-run*.json`):

| Scale | Share | Share kbps | Camera | Camera kbps | Wire total |
|---|---|---|---|---|---|
| 1 | 1920×1080 | 839 / 772 | 1280×720, limited by bandwidth | 978 / 983 | 1,910 / 1,846 |
| 1.5 | 1280×720 | 429 / 424 | 1280×720 | 982 / 986 | 1,494 / 1,494 |
| 3 | 640×360 | 189 / 184 | 640×360 | 1,065 / 952 | 1,337 / 1,219 |
| paused | — | 1 / 1 | — | 0 / 0 | 64 / 65 |

A text share's bytes follow its pixels, and 360p is 23% of 1080p. The camera's don't.

The same runs show Chrome splitting the estimate badly. The estimate sat at 4.6–6.1 Mbps. The
share, at `priority: "high"`, got a target of 3.5–4.6 Mbps and used about 0.8. The camera got
about 1 Mbps, and Chrome scaled it from 1080p to 720p for bandwidth on a link with no limit.
Chrome doesn't hand one stream's unused target to another.

**Motion share alone** (`sizes-screen-motion-h264.json`): 11,829 kbps at 1080p, 7,571 at 720p
and 4,410 at 360p. Under a 50 Mbps cap it takes whatever the link gives it.

### How the sender's estimate follows its uplink

`availableOutgoingBitrate` on the selected candidate pair, sampled every 200 ms while sending a
720p camera, a 1080p text share and the mic through the relay (`estimate.json`):

| Change | Before | Time until at or under the cap | Settled at |
|---|---|---|---|
| unlimited → 2 Mbps | 5,370 kbps | 0.8 s | 1,848 kbps |
| 2 Mbps → unlimited | 1,840 | — | 4,829 at 2 s, 5,221 settled |
| unlimited → 0.8 Mbps | 5,252 | 3.8 s (1,025 at 1 s, 835 at 3 s) | 691 |
| 0.8 Mbps → unlimited | 671 | — | 2,665 at 1 s, 5,139 at 2 s |

At 0.8 Mbps Chrome kept the camera at 1280×720 and 30 fps on about 130 kbps, and reported no
quality limit. The share kept 1920×1080 on about 270 kbps, and its frame rate fell to 1–8 fps.
Over the whole 170 s run the viewer counted 13 freezes on the share, 9 s in total. With 670 kbps
to spend, a 180p camera and a readable share at a few frames a second would have looked better.

The estimate is only a floor while the sender has little to send. With the video paused and the
mic running, it fell to 120–180 kbps within 25 s. When the video came back, Chrome probed it back
up to 5.2–5.5 Mbps in 2 s on the unshaped link.

### What `setParameters` costs

Each change was made 3 times (`params-*.json`). Times run from the call to the viewer's first
frame at the new size, taken from `requestVideoFrameCallback`. The call itself resolved in
0–5 ms every time.

| | H.264 camera | VP9 camera | H.264 text share |
|---|---|---|---|
| Step down | 41–90 ms | 34–97 ms | 158–327 ms |
| Step up to 1080p | 53–90 ms | 22–74 ms | 468–1,003 ms |
| Longest gap between frames | 50–83 ms | 50–83 ms | 67–200 ms down, 367–933 ms up |
| Keyframes per size change | 1 (once 2) | 1 | 1–2 |
| Pause | encoder stops in 130–137 ms | 135–144 ms | 130–137 ms |
| Resume | first frame in 65–69 ms, 1 keyframe | 58–119 ms, 1 keyframe | 68–69 ms, but once only 1 frame drawn in 5 s |
| `maxFramerate` 30 ↔ 10 | no keyframe, in effect within 1 s | same | same |

A size change needs no renegotiation, doesn't freeze a camera, and costs one keyframe. The share
is slower. Its 1080p keyframe is large, and a step up froze the viewer's picture for up to 0.9 s.
Every change is a keyframe for everybody watching that stream, so changes need to be rare.

### Resuming a paused share

I ran into this by accident. After all video had been paused for 25 s with the mic running, and
was then resumed with `active: true`:

| How it was resumed | Runs | Result |
|---|---|---|
| Camera and share at once, or a share that was the only video | 6 | share still frozen 5–30 s later; the camera took up to 8 s |
| `degradationPreference: "balanced"` on the share, then both at once | 1 | share frozen for 30 s |
| Share first, camera 3 s later | 1 | share back after 10–20 s |
| Camera first, share 3 s later | 1 | both back after 5 s |
| Both at once, then `active` toggled off and on for any sender that encoded nothing in the last second | 1 | both back after 3 s |
| Share alone, 25 s pause, no mic | 2 | back at once |
| Pauses of 2.5–4 s, any order | 24 | back at once 23 times; once a share drew 1 frame in 5 s |

It takes a long pause and a collapsed estimate. The frozen share's target came back at
3.3–3.6 Mbps while it encoded no frames at all. I can't say whether real `getDisplayMedia`
capture, or Windows, does the same. A watchdog costs almost nothing, so the design has one either
way.

### What feedback reaches the SFU

A census build of the SFU (`sfu-rtcp-census.patch`) counted RTCP by type for 30 s with a sender
and a viewer:

- From the viewer: TWCC feedback at about 16 packets a second, receiver reports, 9 PLIs, and no
  REMB. The SFU acts on the PLIs and drops the rest.
- From the sender: sender reports, SDES and XR.
- Both SDPs map transport-cc to extension id 5. `TrackLocalStaticRTP` only rewrites SSRC and
  payload type when it forwards, so the viewer receives the sender's transport-wide sequence
  numbers, mixed across every sender in the room. Its TWCC feedback describes another leg's
  numbering and would be useless even if the SFU read it.

For the SFU to know a viewer's downlink, it would need its own sequence numbers on outgoing
packets (pion's `ConfigureTWCCHeaderExtensionSender`) and a send-side estimator per viewer
connection (pion's `cc` interceptor with `gcc.NewSendSideBWE`). That touches every packet the SFU
sends, so it's stage 4 if it's needed at all.

### What spatial layers cost

VP9 camera at 1080p under the same 2.5 Mbps cap, switched with `setParameters`
(`svc-vp9-camera.json`):

| Mode | kbps | Frames encoded per second | Encode per frame |
|---|---|---|---|
| L1T3 | 2,556–2,573 | 30 | 2.58–3.92 ms |
| L3T3_KEY | 2,556–2,580 | 90 | 5.80–6.44 ms |

The three layers share the same 2.5 Mbps, so the top layer gets less of it, and encoding takes
about 1.7 times as long on average. H.264, Gryt's default, has no spatial layers in Chrome.

## The design

### 1. Signals

**What the viewer reports**, per remote video track: `{ track_id, width, height, fps }`.

- `width` and `height` are the video's drawn size in device pixels, which isn't always the tile's.
  For `contain` it's the fitted box. For `cover` it's the covering box, which is bigger than the
  tile one way. Both come from the element's content box, the video's aspect ratio
  (`videoWidth / videoHeight`, which scaling doesn't change) and `devicePixelRatio`.
- 0×0 when the element is `display: none`, scrolled out of view (IntersectionObserver), the
  document is hidden (`visibilityState`) or the window is minimised.
- The same track can be drawn in several places: the grid, the focus view, a popout. The client
  reports the largest. A popout measures with its own window's pixel ratio and visibility.
- `fps` is the display's refresh rate, measured from `requestAnimationFrame` intervals. That
  stops a sender sending 87 fps to a 60 Hz screen, which is Al's case: 6,771 of 51,449 frames
  dropped.
- Rounded up to a multiple of 16, so a one-pixel resize isn't a message.

**When.** An increase goes out after 100 ms without another change, a decrease after 1 s. A
window drag fires dozens of ResizeObserver callbacks and should send one or two messages. The
sender holds decreases as well, below.

**Over which channel.** The SFU websocket. It's already per call, the aggregation lives in the
SFU, and a report goes away with its connection. Reports are addressed by track id, like
`set_layer` is (`GetForwarder(roomID, trackID)`). After an SFU reconnect the engine re-sends its
last report for every track.

### 2. Where the decision is made

| | Knows | Doesn't know |
|---|---|---|
| Viewer | its own drawn size, refresh rate and visibility | anybody else's |
| SFU | every viewer of every track, who joins and leaves, which sender a track came from and on which m-line | the source size, the content, the encoder, the sender's upload |
| Sender | source size, content hint, codec, encoder, its send estimate, all its own streams | who's watching, and how big |

So the SFU aggregates and the sender allocates.

- **SFU:** the largest report per track, a count of viewers that haven't reported (old clients),
  and a forwarding gate for viewers at 0. It sends the sender `video_wanted { mid, width, height,
  fps, watchers, unknown }`, addressed by the mid of the sender's own m-line. The SFU knows that
  from the transceiver the track arrived on.
- **Sender:** everything about encodings. It's the one place that can weigh a camera against a
  share against the upload. Its estimate already covers the path into the SFU, because that path
  is what the SFU's TWCC feedback measures.

The other place to aggregate is the Gryt server's socket, which would avoid a review-required
SFU change. But the server doesn't know who's subscribed on the SFU, can't stop forwarding, and
goes stale when the SFU reconnects. I'd keep it as the fallback.

Old clients are covered by `unknown`. A viewer that never reports counts as wanting full size, so
an old client never sees a paused or shrunken stream. A sender on an old engine ignores
`video_wanted`. An old SFU never sends it, and the new engine keeps today's behaviour.

### 3. The allocation rule

**Stage 1, per stream, with no budget:**

- Size: a ladder of scales, 1, 1.5, 2, 3, 4, 6 and 8. On a 1080p source that's 1080, 720, 540,
  360, 270, 180 and 135. Pick the largest scale whose output still covers the wanted size, and
  never go above the source. The ladder keeps a window drag from turning into a keyframe per
  pixel.
- Bitrate for a camera: 2.5 Mbps at 1080p30 (Chrome's own default), scaled by pixels^0.75 and by
  (fps/30)^0.7, the fps curve `estimateBitrate` already uses. That's about 1.4 Mbps at 720p, 0.9
  at 540p, 0.5 at 360p and 0.17 at 180p.
- Bitrate for a share: `estimateBitrate(rung, fps)`, the table the picker already has.
- Frame rate: the lower of what the user picked and the highest refresh rate anybody reported.
- Up at once. Down after 5 s at a lower rung. Pause after 10 s at 0. Resume at once, and if the
  encoder hasn't produced a frame 1 s later, toggle `active` off and on again.

**Stage 2, the budget.** The budget is the send estimate, or the SFU's ingest cap if the operator
set a lower one, minus audio, minus 10%. Then:

1. Streams nobody watches are paused.
2. Every watched stream starts at the rung and frame rate that serves its demand.
3. If the total fits, that's it. Each stream's `maxBitrate` is its own need, which also stops
   Chrome parking the estimate on a high-priority share that isn't using it.
4. If it doesn't fit, take from these in order until it does: camera frame rate down to 15;
   camera down a rung at a time to 180p; windows viewed at under half their size down a rung; a
   large-viewed share's frame rate down to 5, keeping its size so the text stays readable; pause
   the camera, so the tile shows the avatar; and last of all, the large-viewed share's size.
5. A falling estimate cuts at once, since that's congestion. In the 0.8 Mbps run, leaving it to
   Chrome gave the share 13 freezes. A rising estimate is only spent after 2 s of 20% headroom.

The estimate is a floor while little is being sent, so the rule can't read capacity off it when
video is paused. After a resume Chrome probed from 120 kbps to 5.4 Mbps in 2 s, and the allocator
runs again every second, so it catches up.

What the server can take in is mostly in the estimate already, since the SFU's feedback governs
it. The estimate can't see an operator's policy, like a small uplink shared by 20 people. That's
an optional per-peer cap, sent in `room_joined`.

### 4. What it won't do

One viewer drawing a stream big pulls it up for everybody else watching. Going by the numbers
above, each viewer with a small tile then downloads, compared with getting 360p:

- a text share at 1080p: about 0.6 Mbps more
- a motion share: about 7.4 Mbps more
- a camera, capped by the rule: about 2 Mbps more

and decodes 1080p for a thumbnail. Giving each viewer its own size needs simulcast or spatial
SVC. Simulcast costs the sender two more encodes and two more uploads. Spatial SVC measured at
about 1.7 times the encode time for the same bytes. It only works on VP9 and AV1, and the
forwarder would have to filter on spatial id as well as temporal. Either way the SFU also has to
know each viewer's downlink, which it doesn't today (see the census).

It pays off when rooms often have one big viewer and several small ones on thin connections.
Stage 1 can tell us how often that happens: the SFU can log, per track, the ratio between the
largest and smallest report. If most streams stay within 2×, stage 1 is enough.

### 5. Several windows

Four fixed slots fit one share. GRYT-1335 needs slots that come and go:

- A client asks for a video slot with `add_slot { kind: "video" }`. The SFU adds a recvonly video
  transceiver and sends a new offer. The mic stays at transceiver 0, so `isMicrophone` holds.
- A client that's done with a window pauses its sender and sends `drop_slot { mid }`. The SFU
  stops that transceiver and drops the track and its forwarder right then. Today it cleans up
  when the connection closes.
- The engine reuses a paused window sender before asking for another slot, and the SFU caps
  slots per peer, at a camera and four windows say.
- `voice:screen:state` becomes a list of `{ streamId, audioStreamId, title }`.

The allocator treats each window as one more stream with its own demand. Windows nobody is
looking at get paused and cost nothing, and that's what makes several of them affordable. Among
the watched windows, the one drawn largest is the large-viewed share in the rule above, and the
rest compete the way cameras do.

### 6. Staged build

**Stage 1: demand, caps and pause.** The SFU goes first, since nothing else does anything
without it.

- **SFU** (review-required). `video_demand` in and `video_wanted` out, in `pkg/types`.
  `ReceiverState` gets a demand and a reported flag. `LayerForwarder.SetDemand` returns the new
  largest and whether it changed, and `RemoveReceiver` does the same, since a viewer leaving can
  lower it. `run()` skips a receiver at 0. When a receiver goes from 0 to watching, the SFU sends
  the sender a PLI, because that viewer has no frame to decode from. The handler finds the
  sender's websocket and the mid of its m-line and writes `video_wanted`, rate-limited like
  `still_here`. Roughly 120 lines. Tests: forwarder units (largest, unknown, a removal lowering
  it, the gate) and a handler test with two pion peers like `handler_rtcp_test.go`.
- **`@gryt/voice`.** `reportVideoDemand(trackId, size)`, deduplicated and re-sent after a
  reconnect. A `video_wanted` handler, and a pure function from source, wanted size, time and
  state to an encoding, holding the ladder, the bitrate rule, the holds and the watchdog.
  Encodings also get one owner. Today `controls.tsx` writes `maxBitrate`, `maxFramerate` and
  `priority` from its own effects, and GRYT-1333 showed what re-running effects do to a sender.
  The client hands its settings to the engine, and the engine merges them with demand. Roughly
  250 lines, plus a `check-video-demand` script like the other `check-*` ones.
- **Client.** A `useDrawnVideoSize` hook on `VideoCard`, `FocusedVideoView` and the popout. It
  covers ResizeObserver, IntersectionObserver, `visibilitychange` and the pixel ratio, and keeps
  the largest per track. The encoding writes in `controls.tsx` move into the engine call.
  Roughly 150 lines.
- **Gate.** Merge order is SFU, then voice, then client. Each PR runs this rig against an SFU
  built from its branch and puts before and after numbers in the body. One sender and two
  viewers: one full screen and one hidden, then both hidden for 30 s, then one back.

**Stage 2: the budget split.** Voice, plus the optional ingest cap in the SFU's `room_joined`,
which is a few lines. The allocator from section 3, fed by the send estimate every second. It's
gated through the relay here with the same 2 Mbps and 0.8 Mbps steps as `estimate.mjs`. At
0.8 Mbps the share should keep its size, and the viewer's freezes on it should go from 13 to
about none.

**Stage 3: several windows.** Dynamic slots in the SFU come first. That's review-required and the
biggest SFU diff of the three, so it gets its own PR with handler tests for adding a slot,
dropping one and reusing one. Then the engine's sender pool, then the list in media state, then
the client. GRYT-1335 covers the capture side.

**Stage 4, if the stage 1 numbers call for it:** per-viewer sizes with simulcast or SVC, and an
SFU estimate of each viewer's downlink.

### 7. Mobile

The phone is parked, so this is only what it would need. The engine is shared, so the sender half
works there once react-native-webrtc's `setParameters` takes `active`, `scaleResolutionDownBy` and
`maxBitrate`. That should be checked on both platforms first. The viewer half needs another way to
measure: `RTCView`'s `onLayout` times `PixelRatio.get()`, and 0 when `AppState` isn't active. A
phone is also the most likely thin downlink, which is the argument for stage 4.

### 8. What I'm unsure about

- **The sources are synthetic.** A noisy canvas isn't a webcam, and a canvas isn't
  `getDisplayMedia`. The camera result, bytes not falling with size, comes from Chrome's target
  rather than the picture, so I expect it holds. A share's bytes per size will vary with what's
  shared.
- **The frozen resume** was seen with canvas sources, on macOS, with VideoToolbox, in Chrome 153.
  I don't know if real capture or Windows does it.
- **The desktop's native capture path.** With native H.264 on Windows, the client injects frames
  that are already encoded (the Encoded Transform in `controls.tsx`), so `scaleResolutionDownBy`
  and `maxBitrate` won't reach them. The allocator would have to drive the helper's encoder. I
  haven't looked at how.
- **The shaper isn't a router.** It has no cross traffic, its rate changes instantly, and its
  buffer is a fixed 150 ms. On a real thin line the estimate will react on its own timings.
- **The share's priority.** Chrome parks 3.5–4.6 Mbps of target on a text share using 0.8.
  Stage 2's caps should fix that. Lowering the share's priority is simpler, but it would hurt a
  motion share.
- **The bitrate rule** (pixels^0.75 down from 2.5 Mbps at 1080p) is a guess anchored on one
  point.
- **The forwarded extensions.** The SFU forwards the sender's transport-wide sequence number and
  MID extension unchanged. Chrome seems fine with it, probably because SSRCs are signalled, but I
  haven't checked what it does with them.

## Running the measurements

Everything's in [`bandwidth-allocation/`](bandwidth-allocation/). It needs Node 24, Go and Google
Chrome on macOS. On Linux, change the Chrome path in `lib.mjs`.

```bash
# the SFU under test, from a Gryt-chat/sfu checkout
go build -o <this repo>/docs/bandwidth-allocation/sfu-main ./cmd/sfu
cd docs/bandwidth-allocation
node sizes.mjs text h264 both        # bytes per size; also motion, vp9, camera or screen
node params.mjs camera h264          # setParameters reaction; also screen, vp9
node estimate.mjs                    # estimate against a stepped uplink; BW_PLAN="0:1000,40:2,..."
node resume-long.mjs both 25 rekick  # resume after a long pause; or together, screen-first, camera-first, balanced
node svc.mjs                         # L1T3 against L3T3_KEY
# stage 1's gate: one sender, one viewer full screen and one hidden, both hidden, one back.
# `old` is a client from before GRYT-1432, `new` runs the engine's own code from ../../dist.
BW_SFU=./sfu-main node gate.mjs before old
# which RTCP reaches the SFU: apply sfu-rtcp-census.patch to the SFU and build it as sfu-census
BW_SFU=./sfu-census node census.mjs
```

Each script starts its own SFU, Chrome and relay on ports 5741–5747 and 9471, and kills them when
it exits, crashes included. Raw samples go to `results/`, and the files there are the runs quoted
above. `BW_HOST` overrides the LAN address the SFU advertises.
