import { SFUConnectionState } from "../types/SFU";

export interface SFUConnectionStateInternal {
  state: SFUConnectionState;
  roomId: string | null;
  serverId: string | null;
  error: string | null;
  /**
   * How long this SFU lets one person sit alone before it ends the call, in seconds. Zero
   * means it does not; null means it did not say — an older one sent a sentence.
   */
  callAloneTimeoutSeconds: number | null;
}

export interface RoomAccessData {
  room_id: string;
  join_token: unknown;
  sfu_url: string;
  sfu_urls?: string[];
  timestamp: number;
}
