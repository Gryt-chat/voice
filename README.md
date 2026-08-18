# @gryt/voice

Gryt's voice engine on its own: signalling, ICE, track management, capture and
the connection state machine.

It was pulled out of the Gryt desktop client so the desktop app, the web app and
the mobile app can share one implementation instead of keeping three in step.

> **Extracted, not published yet.** Everything has moved across and the package
> typechecks and builds, but no version above `0.0.1` is on npm and the desktop
> client still runs from its own copies. See GRYT-341 for the migration.

## What it does and does not decide

The engine is told where to connect and what to capture, and reports what
happened. It does not know which server is on screen, which servers exist, or
whether one was removed. That sounds like a small distinction and it is the one
that decides what belongs here.

Anything the engine cannot work out for itself arrives through one of five
seams:

`VoiceConfig` is what the person has chosen: microphone, camera and screen
settings, input mode, whether noise suppression is on. It arrives through
`VoiceConfigProvider` and changes while a call is running, which is why it is a
React context rather than something set once at startup.

`VoiceHost` answers two questions about the platform, and they are separate on
purpose. `hasNativeCapture()` asks whether native capture exists.
`allowsInsecureTransport()` asks whether a plain `ws://` connection to a private
address is allowed. The client used to ask `isElectron()` for both, which gives
the right answer on the desktop by coincidence: React Native has native capture
and no mixed-content rule, so folding them together would quietly break LAN
servers on a phone.

`SfuTransport` carries offers, answers and candidates. It is generic WebRTC, so
an embedder can move those messages over anything it likes.

`RoomCoordinator` handles asking to join a channel and telling the server what
is being published. That part is Gryt's rules rather than WebRTC's, since the
server decides who may enter and how many fit.

`VoicePlatform` covers capture, playback and peer construction. The web
implementation is the code that moved out of the client; the native one uses
`react-native-webrtc` and `react-native-audio-api`.

## What it will not do for you

No sounds, no toasts, no notifications. The engine reports state and the app
decides what that means. A refused room request comes back as a `RoomAccess`
with a reason and a retry delay, and whether that deserves a toast is not the
engine's call.

That is not minimalism for its own sake. Every one of those decisions differs
between a desktop app, a browser tab and a phone, and an SDK that makes them for
you is one you end up fighting.

## Noise suppression is deliberately not ported

The web adapter keeps RNNoise. The native one does not, and should not.

Native WebRTC ships echo cancellation, noise suppression and automatic gain
control, and phones have hardware echo cancellation on top. The RNNoise worklet
exists because noise suppression in browsers is weak, and that reason does not
survive the move to a phone. Adding it back would spend battery and CPU
duplicating something the platform already does.

## Push-to-talk is split in half

The engine owns the gate, which is the part that opens and closes the transmit
gain. The app owns the trigger.

A key is not the only way to ask to talk. The desktop listens for a keypress and
an Electron global shortcut; a phone holds a button on a screen. So the app
calls `setPushToTalkActive` and the engine decides what that means, including
what happens when someone unmutes mid-press.

## Not bundled, on purpose

The build is unbundled output, one file in for one file out. Metro picks between
`.native.ts` and `.web.ts` per file, and a bundle has no files left to pick
between, so bundling would rule out the platform split this package exists for.

Relative imports get their `.js` extensions added after compilation rather than
written into the source, which keeps the source readable and the output loadable
outside a bundler.

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

AGPL-3.0, the same as the client, server, SFU and the rest of Gryt. See
[LICENSE](LICENSE).

[`@gryt/ui`](https://github.com/Gryt-chat/ui) is the exception in this org, and
deliberately so: it is generic components with nothing of Gryt in them, and
copyleft there would rule out most of the people who might use it.

This is not that. Signalling, ICE handling, track management and the connection
state machine are the product rather than scaffolding around it. Copyleft here
means somebody running a modified Gryt voice engine as a service publishes their
changes, which is the same reason the apps are AGPL and applies more strongly
here than it does to a button.

It is still yours to embed, self-host and modify. The licence only bites for
running a modified version as a closed service.
