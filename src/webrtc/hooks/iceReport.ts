/**
 * What ICE tried, for a call that never connected (GRYT-9). Every candidate and pair, so a
 * failure on mobile data says which address family and which pairs it tried.
 */

interface StatLike {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface IceFailureReport {
  /** Ours, without the address: a server-reflexive one is the person's public IP. */
  local: string[];
  /** The SFU's, address included. That's the server's, and the thing being diagnosed. */
  remote: string[];
  /** Each pair that left `frozen`, and how far it got. */
  pairs: string[];
}

function family(address: string): string {
  if (!address || address === "?") return "?";
  if (address.endsWith(".local")) return "mdns";
  return address.includes(":") ? "v6" : "v4";
}

export function iceFailureReport(stats: Iterable<StatLike>): IceFailureReport {
  const local = new Map<string, string>();
  const remote = new Map<string, string>();
  const pairs: StatLike[] = [];

  for (const stat of stats) {
    const address = String(stat.address ?? stat.ip ?? "?");
    const kind = `${String(stat.candidateType ?? "?")}/${String(stat.protocol ?? "?")}`;
    if (stat.type === "local-candidate") {
      const network = stat.networkType ? ` ${String(stat.networkType)}` : "";
      local.set(stat.id, `${kind} ${family(address)}${network}`);
    } else if (stat.type === "remote-candidate") {
      remote.set(stat.id, `${kind} ${address}:${String(stat.port ?? 0)}`);
    } else if (stat.type === "candidate-pair") {
      pairs.push(stat);
    }
  }

  return {
    local: [...new Set(local.values())],
    remote: [...new Set(remote.values())],
    pairs: pairs
      .filter((p) => p.state && p.state !== "frozen")
      .map((p) => {
        const l = local.get(String(p.localCandidateId)) ?? "?";
        const r = remote.get(String(p.remoteCandidateId)) ?? "?";
        const sent = Number(p.requestsSent ?? 0);
        const answered = Number(p.responsesReceived ?? 0);
        return `${l} -> ${r}: ${String(p.state)} (${answered}/${sent} checks answered)`;
      }),
  };
}
