/**
 * The SFU makes every offer, so the only m-lines that can carry our media are the ones it
 * opened to receive on. A transceiver made here has no place in its offer and never sends.
 */
interface SfuSlot {
  mid: string;
  kind: string;
}

/** The m-lines the SFU takes media on, in offer order: recvonly, or sendrecv once it forwards on one. */
export function sfuSlots(pc: RTCPeerConnection): SfuSlot[] {
  const sdp = pc.remoteDescription?.sdp;
  if (!sdp) return [];

  const slots: SfuSlot[] = [];
  for (const section of sdp.split(/\r?\nm=/).slice(1)) {
    const kind = section.slice(0, section.indexOf(" "));
    const mid = /\na=mid:(\S+)/.exec(section)?.[1];
    const direction = /\na=(sendrecv|sendonly|recvonly|inactive)\b/.exec(section)?.[1] ?? "sendrecv";
    if (mid && (direction === "recvonly" || direction === "sendrecv")) slots.push({ mid, kind });
  }
  return slots;
}

function isStopped(transceiver: RTCRtpTransceiver): boolean {
  return transceiver.direction === "stopped" || transceiver.currentDirection === "stopped";
}

/** The transceiver `addTrack` would reuse for this kind, by the spec's rule, or undefined for a new one. */
function addTrackTarget(pc: RTCPeerConnection, kind: string): RTCRtpTransceiver | undefined {
  return pc.getTransceivers().find((transceiver) =>
    !isStopped(transceiver) &&
    transceiver.receiver.track?.kind === kind &&
    transceiver.sender.track === null &&
    transceiver.currentDirection !== "sendrecv" &&
    transceiver.currentDirection !== "sendonly");
}

/**
 * Puts a role's first track on a slot the SFU offered that no other sender holds. Null means no
 * slot is free or it can't be claimed here, and the caller falls back to `addTrack`.
 */
export function publishOnSfuSlot(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
  held: readonly (RTCRtpSender | null | undefined)[],
): RTCRtpSender | null {
  const slots = sfuSlots(pc);
  // The SFU takes the first audio m-line as the microphone, so nothing else goes there.
  const microphone = slots.find((slot) => slot.kind === "audio")?.mid;
  const mids = slots
    .filter((slot) => slot.kind === track.kind && slot.mid !== microphone)
    .map((slot) => slot.mid);

  const transceivers = pc.getTransceivers();
  let slot: RTCRtpTransceiver | undefined;
  for (const mid of mids) {
    slot = transceivers.find((transceiver) =>
      transceiver.mid === mid &&
      !isStopped(transceiver) &&
      transceiver.sender.track === null &&
      !held.includes(transceiver.sender));
    if (slot) break;
  }
  if (!slot) return null;

  // addTrack puts the track on the sender at once, which the client's roleSender reads
  // straight after, so it is used whenever it would land on this same slot.
  if (addTrackTarget(pc, track.kind) === slot) {
    const sender = pc.addTrack(track, stream);
    if (sender === slot.sender) return sender;
    if (!held.includes(sender)) pc.removeTrack(sender);
  }

  // No setStreams on react-native-webrtc, and without it the SFU forwards under a stream id nobody announced.
  if (typeof slot.sender.setStreams !== "function") return null;

  // sendrecv like addTrack, since the SFU may be forwarding somebody else on this m-line too.
  slot.direction = "sendrecv";
  slot.sender.setStreams(stream);
  slot.sender.replaceTrack(track).catch(() => undefined);
  return slot.sender;
}
