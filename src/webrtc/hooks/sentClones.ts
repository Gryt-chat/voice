/** Microphone clones made per connection (voice#53). Only the disconnect may stop them. */
export const sentClones = new WeakSet<MediaStreamTrack>();
