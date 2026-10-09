/* eslint-env node */

// A call that never connects has no selected pair. The report then has to name every
// candidate and pair, without our own address (GRYT-9).

import assert from "node:assert/strict";

const { iceFailureReport } = await import("../dist/webrtc/hooks/iceReport.js");

const report = iceFailureReport([
  { id: "L1", type: "local-candidate", address: "100.64.3.9", port: 50000, candidateType: "host", protocol: "udp", networkType: "cellular" },
  { id: "L2", type: "local-candidate", address: "2a02:2121::1", port: 50001, candidateType: "srflx", protocol: "udp" },
  { id: "R1", type: "remote-candidate", address: "203.0.113.7", port: 40000, candidateType: "host", protocol: "udp" },
  { id: "P1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", state: "failed", requestsSent: 9, responsesReceived: 0 },
  { id: "P2", type: "candidate-pair", localCandidateId: "L2", remoteCandidateId: "R1", state: "frozen" },
  { id: "T", type: "transport" },
]);

assert.deepEqual(report.local, ["host/udp v4 cellular", "srflx/udp v6"]);
assert.deepEqual(report.remote, ["host/udp 203.0.113.7:40000"]);
assert.deepEqual(report.pairs, ["host/udp v4 cellular -> host/udp 203.0.113.7:40000: failed (0/9 checks answered)"]);

const text = JSON.stringify(report);
assert.ok(!text.includes("100.64.3.9") && !text.includes("2a02:2121::1"), "our own addresses leaked");

console.log("ice failure report: ok");
