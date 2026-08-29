import { SFUConnectionState } from "../types/SFU";

export interface SFUConnectionStateInternal {
  state: SFUConnectionState;
  roomId: string | null;
  serverId: string | null;
  error: string | null;
  /**
   * How long this SFU lets one person sit alone in a call before it ends it,
   * in seconds. Zero means it does not. Null means the SFU did not say — an
   * older one, which sent a sentence where this number now is.
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
