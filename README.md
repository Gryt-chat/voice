# @gryt/voice

Gryt's voice engine, on its own. Signalling, ICE, track management and the
connection state machine, with adapters for the browser and for React Native.

Extracted from the Gryt desktop client so that the client, the web app and the
mobile app can share one implementation rather than three.

> **Not usable yet.** The repository exists so the extraction has somewhere to
> land. See GRYT-334 for the plan and `handoff-2026-08-18-sdk.md` in the
> [main repository](https://github.com/Gryt-chat/gryt) for the ordering.

## What goes in here

The parts of voice that are not platform-specific move across unchanged, since
they are already plain TypeScript: signalling, ICE handling, track management
and the connection state machine.

What sits behind an adapter is narrower than it first looks:

- `getUserMedia` and `getDisplayMedia`
- device enumeration through `navigator.mediaDevices`
- everything touching `AudioContext`, `AudioWorklet` and `createAnalyser`
- `RTCPeerConnection` construction, which differs between the browser and
  `react-native-webrtc`

Two adapters ship: a web one, which is the existing client code moved, and a
native one built on `react-native-webrtc` and `react-native-audio-api`.

## Noise suppression is deliberately not ported

The web adapter keeps RNNoise. The native one does not, and should not.

Native WebRTC ships echo cancellation, noise suppression and automatic gain
control, and phones have hardware echo cancellation on top. The RNNoise worklet
exists because noise suppression in browsers is weak — a reason that does not
survive the move to a phone. Adding it back would cost battery and CPU to
duplicate something the platform already does.

## Issues

Please report bugs and request features in the
[main Gryt repository](https://github.com/Gryt-chat/gryt/issues).

## Sponsors

What sponsoring pays for, the tiers, and everyone who has sponsored:
[gryt.chat/sponsors](https://gryt.chat/sponsors). To sponsor:
[GitHub Sponsors](https://github.com/sponsors/Gryt-chat).

The list itself lives in the [Gryt README](https://github.com/Gryt-chat/gryt#sponsors),
in one place rather than ten, so it cannot fall out of step across repositories.

## License

MIT — see [LICENSE](LICENSE).

Like [`@gryt/ui`](https://github.com/Gryt-chat/ui), and for the same reason. The
Gryt apps are AGPL-3.0, because somebody running a modified Gryt as a service
should publish their changes. A library meant to be picked up and built on is a
different thing, and AGPL would make that impossible for most of the people who
might use it.
