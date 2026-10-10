# Receive leveling (early implementation)

This opt-in web receiver feature handles one person's quiet voice followed by a
sudden shout. The sender pipeline is unchanged. The library default is **false**;
an embedder may offer its own persisted default and must show actual DSP state.
This implementation is under review. Human voice listening, games under load,
physical device changes and real two-way calls have not been validated.

## Integration

```ts
import type { ReceiveLevelingState, ReceiveAudioRole } from "@gryt/voice";

// VoiceConfig.audio
const audio = { /* existing settings */, receiveLevelingEnabled: true };

// Inside a component using the existing hooks:
const { receiveLevelingState } = useSpeakers();
const { streamSources } = useSFU();
const source = streamSources[streamId];
source?.receiveCleanup?.setRole("microphone" satisfies ReceiveAudioRole);
source?.receiveCleanup?.setMuted(volume === 0);
source?.gain.gain.setValueAtTime(volume, source.gain.context.currentTime);
```

The optional `receiveCleanup` is a `ReceiveStreamControl` with `setRole`,
`setMuted` and idempotent `dispose`. The SFU lifecycle owns disposal; embedders
normally set only role and mute. Set mute before changing the manual gain so
lookahead tails are cleared. Preserve existing slider conversion; `volume` in
the example is a linear gain, not the UI percentage. All aliases of one audio
track share the same route and controls.

New routes are `unknown`. Classify from trusted socket metadata, with screen
audio taking precedence if aliases conflict. Only `microphone` enables leveling
and compression. `screen` and `unknown` keep manual gain and peak protection,
without boosting. Reapply roles/mute after stream replacement or a new context.
The stream analyzer stays before automatic/manual gain. The receiver owns the
summed bus returned by `useSpeakers().remoteBusNode`; avoid connecting a second
playback path or adding gain after its final guard.

`ReceiveLevelingState` is exported at the package root. The hook subscribes to
the current context and replays its current state on subscription. A replaced
context disposes the old graph and subscriptions. No extra callback is required.

| status | Meaning |
| --- | --- |
| disabled | All leveling, compression and limit processing bypassed; manual gain remains. Already created worklets retain their delay. |
| loading | Module/node installation in progress; conservative fallback is audible. |
| active | The current context is running and all attached DSP routes and the bus are installed. This does not imply speech classification or device quality. |
| degraded | Installation or processor failure; adaptive boost removed, fixed attenuation and digital guards used while retrying. |
| suspended | Context is suspended/closed or has not yet been supplied. |

`reason` is an optional diagnostic code, including `awaiting-audio-context`,
`audio-context-suspended`, `audio-context-closed`, `worklet-unavailable`,
`stream-processor-error` and `bus-processor-error`. Do not translate it as normal
operation. React Native has no receiver AudioWorklet; this feature currently
applies to web only.

`latencyMs` describes the maximum **currently installed added DSP delay**,
excluding WebRTC, device buffers and browser scheduling. Each limiter delays
`ceil(sampleRate * 0.003)` samples; a stream plus bus is 6 ms at 48 kHz and
6.031746 ms at 44.1 kHz. A bus with no attached routes contributes one delay.
A never-enabled disabled graph has 0 ms. A healthy graph switched off retains
the installed delays and reports them. Fallback removes DSP nodes and reports
0 ms; this value follows the graph rather than assuming every disabled or
degraded state has zero delay. Switching output sinks within the same context
does not reinstall the module.

## Signal path and guarantees

```
remote mic -> slow leveling + downward compression -> manual GainNode
           -> stream lookahead limiter -> numerical guard -> summed bus
           -> bus lookahead limiter -> final numerical guard -> destination
remote screen/unknown -> bypass leveling -> same manual/limiter/bus path
```

Measurements are before manual gain, independently per remote microphone.
Manual 0/100/200% does not make the controller compensate in the opposite
direction. Nothing adds gain after the final guard. Each stereo limiter links
both channels. Inputs containing NaN/Infinity are replaced with zero.

| Setting | Initial value |
| --- | --- |
| Slow energy target / gain bounds | -24 dBFS / -9 to +9 dB |
| Upward / downward slow gain rate | +1.5 / -6 dB per second |
| Energy frames / upward activity qualification | 10 ms / 100 ms |
| Inactivity reset toward unity | after 500 ms |
| Downward compressor | -18 dBFS threshold, 4:1, 6 dB soft knee, no makeup |
| Compressor attack / release | 2 / 150 ms |
| Limiter lookahead / release / ceiling | ceil(3 ms) / 60 ms / -3 dBFS |

The compressor and limiter see sudden peaks without waiting for speech activity.
The leveler uses an energy/noise heuristic, **not a speech VAD**. Quiet stationary
test noise does not acquire boost, but loud sustained background noise can pass
the heuristic and receive bounded gain. Silence does not grow gain without
bound. Role changes and disabled processing reset adaptive state. Enabling
leveling ramps its contribution for 10 ms. The limiter delays the first sample
rather than discarding the start of speech. Disable bypasses limiter gain and
guards for new samples; already buffered enabled samples retain numerical peak
protection until drained, so stale boost is not emitted naked.

The declared ceiling is a **sample peak** limit on enabled output. It is not a
true-peak/oversampled limit or a hearing-safety promise. Upstream clipping and
distortion cannot be reconstructed. Disabled output may exceed full scale when
manual gain or the source does so. The WaveShaper guards are final hard numerical
caps and degraded protection, not substitutes for the lookahead limiter.

## Failure and lifecycle

While enabled and loading, or on any stream/bus `processorerror`, all adaptive
nodes are disconnected. The fallback is input -> fixed 0.5 gain -> manual gain
-> stream guard -> bus guard -> destination. It never preserves a boosted
unlimited path. Native graph guards stay active with the same ceiling. Failure
is observable; retries back off from 1 to 30 seconds. A failed module load is
removed from the per-context cache and retried. A successful module is loaded
only once for that context; new nodes replace failed processors.

Mute uses a zero guard immediately and clears worklet history on its next
quantum. Suspend/resume publishes state and checks recovery on resume. Stream
cleanup disconnects nodes, closes ports and stops processing. Context disposal
cancels retries, removes listeners and invalidates pending installation. Aliased
cleanup is idempotent. Rewiring on failure/recovery can produce a brief dip or
click; seamless recovery has not been demonstrated. Other browser/graph
failures outside the monitored worklets remain subject to the existing voice
engine's recovery behavior.

The realtime core preallocates buffers in constructors, uses sample-rate-derived
timing and handles variable blocks. It has no per-quantum logs, posted metrics,
promises or array construction. Graph changes and status subscriptions run on
the main thread. There is no per-stream neural model.

## Sources and licensing

The lookahead limiter is a TypeScript adaptation of Signalsmith's mature
PeakHold + one-stage BoxFilter gain smoothing, with fixed configuration, finite
input handling and a separate numerical guard:

- [Signalsmith basics limiter, 369e906e03760ec219d07b06fa06dc4fd099f377](https://github.com/Signalsmith-Audio/basics/blob/369e906e03760ec219d07b06fa06dc4fd099f377/include/signalsmith-basics/limiter.h)
- [Signalsmith DSP envelopes, 4f62b0a8783c483c353d0232654fe0ffea3cd434](https://github.com/Signalsmith-Audio/dsp/blob/4f62b0a8783c483c353d0232654fe0ffea3cd434/envelopes.h)
- [Giannoulis, Massberg and Reiss, JAES 60(6), 2012](https://joshreiss.github.io/documents/2012/GiannoulisMassbergReiss-dynamicrangecompression-JAES2012.pdf): feed-forward compression and the soft-knee equation. Compressor/slow controller code is local implementation.
- [WebRTC AGC2 adaptive digital controller](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/agc2/adaptive_digital_gain_controller.cc): bounded gain and noise/activity constraints informed the design. This package does not include or claim to implement AGC2.

The original Signalsmith MIT notices are included in
`third-party/Signalsmith-LICENSE.txt` and `Signalsmith-DSP-LICENSE.txt`, including
the npm package. Voice and these modifications remain AGPL-3.0-only, with the
third-party portions retaining their MIT notices.

The port initially missed the PeakHold reblock branch and sentinel capacity for
tiny windows; naive window tests caught both. The final implementation retains
the upstream branching and uses a power-of-two capacity strictly larger than
the active window. An independent original C++ build verifies the final port.

## Reproducible evidence

The evidence JSON files in `docs/receive-leveling/evidence` record these runs:

- `npm run build`, `npm run typecheck` and the existing check scripts passed.
- `npm run check-receive-dsp`: 28 checks at 8/16/44.1/48/96 kHz, including
  quiet -> shout -> quiet, silence/noise, cold impulses, clipped inputs,
  manual 0/100/200%, disable with pending lookahead, independent streams,
  eight aligned streams plus bus, stereo/non-finite input and mute tails.
- `node scripts/check-signalsmith-reference.mjs <reference.bin>` compares
  81,920 stereo samples across five rates against the original C++ double
  limiter. Maximum absolute difference is about 2.04e-8 (Float32 output).
  Compile `scripts/receive-signalsmith-reference.cpp` with the pinned basics
  include directory and DSP headers under `signalsmith-dsp/`; its executable
  takes the output binary path as its first argument.
- `node scripts/check-receive-headless.mjs <playwright-test-entry.mjs>` uses
  real Chromium AudioWorklet with muted output and synthetic buffers/oscillators.
  Chromium 153.0.8010.12 at 44.1/48 kHz matched the core sample-for-sample,
  including stereo upmix, first-sample delay and disabled raw output. It covered
  first-load failure/retry, role/mute, error callbacks, a genuine throwing
  processor, suspend/resume, stream recreation and cleanup. Playwright is a
  harness dependency supplied separately; no physical microphone is used.
- `npm run bench-receive-dsp`: sequential Node v22.23.2, Windows x64,
  Intel i7-14700K, requested BelowNormal priority, stereo 48 kHz/128 frames,
  200 warmup and 400 measured blocks, 1/4/8/16/32 routes plus manual gain and
  a bus. Means were 0.0167/0.0568/0.1300/0.2288/0.4619 ms per block; the
  2.6667 ms block budget is only a comparison. This excludes browser scheduling,
  graph nodes, decoding, devices and gameplay, and proves no realtime deadline.

In the 48 kHz quiet/shout fixture, raw quiet RMS 0.01414 rises by about 5.11 dB
after 3-4 seconds. Raw shout RMS 0.67175 falls to about 0.1383, and the maximum
sample peak is 0.707945764. These are synthetic measurements, not perceptual
voice quality results. Human listening, realistic background-noise fixtures,
mobile/browser coverage and real calls remain follow-up acceptance work.
