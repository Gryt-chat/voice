/**
 * The two sounds the engine asks for: joining a call, and leaving one.
 *
 * `useSFU` and `sfuConnectFlow` call the client's `playNotificationSound` with
 * an mp3 URL and a volume, both read from settings and both defaulting to a
 * bundled asset. None of that survives the move.
 *
 * The URL does not, because the assets are the embedder's — a phone plays a
 * system sound, and a browser tab plays an mp3 through Web Audio. The volume
 * does not either: it is a preference about the app's sounds rather than
 * anything the engine reasons about, and threading it through the connect flow
 * only to hand it straight back was already awkward before there were two
 * platforms.
 *
 * So the engine says which of the two moments happened, and the embedder
 * decides what that sounds like, how loud, or whether it makes a sound at all.
 */

export type VoiceSound = "connect" | "disconnect";

export interface VoiceSounds {
  play(sound: VoiceSound): void;
}

/** Silence, which is what a platform without any sounds wired up gets. */
export const silentSounds: VoiceSounds = {
  play: () => {},
};

let current: VoiceSounds = silentSounds;

/** Called once by the embedder, before any voice code runs. */
export function setVoiceSounds(sounds: VoiceSounds): void {
  current = sounds;
}

export function getVoiceSounds(): VoiceSounds {
  return current;
}
