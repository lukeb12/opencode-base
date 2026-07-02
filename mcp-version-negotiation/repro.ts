/**
 * Repro: MCP protocol-version negotiation is a lossy two-probe exchange, not a
 * set intersection. It fails to find an existing common version when either
 * side's supported-version set is *gappy* (non-contiguous).
 *
 * Ground truth (verbatim from @modelcontextprotocol/sdk@1.29.0):
 *
 *   server/index.ts  _oninitialize():
 *     const requestedVersion = request.params.protocolVersion;
 *     const protocolVersion =
 *       SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
 *         ? requestedVersion
 *         : LATEST_PROTOCOL_VERSION;      // <- server returns its OWN latest
 *
 *   client/index.ts  connect():
 *     protocolVersion: LATEST_PROTOCOL_VERSION,   // <- client sends its OWN latest
 *     ...
 *     if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion))
 *       throw new Error(`Server's protocol version is not supported: ...`);
 *
 * Note: MCP versions are YYYY-MM-DD, so lexicographic order == chronological
 * order; `max` of a set is just its greatest string.
 */

import {
  Server,
} from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js"

type Version = string
const latest = (set: Version[]) => [...set].sort().at(-1)!

// ---- Faithful port of the CURRENT SDK algorithm (two probes) ---------------
function negotiateCurrent(client: Version[], server: Version[]) {
  const requested = latest(client) // client sends its LATEST
  const returned = server.includes(requested) ? requested : latest(server) // server echoes or returns its LATEST
  const accepted = client.includes(returned) // client accepts only if it supports the returned version
  return accepted ? { ok: true as const, version: returned } : { ok: false as const }
}

// ---- The proposed FIX: choose max element of the intersection --------------
function negotiateIntersection(client: Version[], server: Version[]) {
  const common = client.filter((v) => server.includes(v)).sort()
  return common.length ? { ok: true as const, version: common.at(-1)! } : { ok: false as const }
}

// The mathematically correct answer we measure both against.
const overlap = (a: Version[], b: Version[]) => a.filter((v) => b.includes(v)).sort()

// Canonical timeline (dates from the real SDK plus the 2026-07-28 RC)
const V = {
  a: "2024-10-07",
  b: "2024-11-05",
  c: "2025-03-26",
  d: "2025-06-18",
  e: "2025-11-25",
  f: "2026-07-28", // RC
}

const CASES: { name: string; client: Version[]; server: Version[] }[] = [
  { name: "same modern SDK", client: [V.d, V.e], server: [V.d, V.e] },
  { name: "newer client vs older server (contiguous overlap)", client: [V.d, V.e, V.f], server: [V.b, V.c, V.d, V.e] },
  { name: "GAPPY client (dropped middle versions)", client: [V.f, V.c], server: [V.c, V.d, V.e] },
  { name: "GAPPY server (LTS + bleeding edge, nothing between)", client: [V.b, V.e], server: [V.f, V.b] },
  { name: "truly disjoint (no common version)", client: [V.f], server: [V.a] },
]

console.log(`SDK under test: @modelcontextprotocol/sdk@1.29.0`)
console.log(`  LATEST_PROTOCOL_VERSION      = ${LATEST_PROTOCOL_VERSION}`)
console.log(`  SUPPORTED_PROTOCOL_VERSIONS  = ${JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS)}`)
console.log()

let bugs = 0
const pad = (s: string, n: number) => s.padEnd(n)
console.log(
  pad("case", 52) + pad("overlap?", 10) + pad("current", 16) + pad("intersection", 16) + "verdict",
)
console.log("-".repeat(110))
for (const c of CASES) {
  const common = overlap(c.client, c.server)
  const hasOverlap = common.length > 0
  const cur = negotiateCurrent(c.client, c.server)
  const fix = negotiateIntersection(c.client, c.server)

  const curStr = cur.ok ? `OK ${cur.version}` : "DISCONNECT"
  const fixStr = fix.ok ? `OK ${fix.version}` : "DISCONNECT"

  // The bug: an overlap exists, but the current algorithm disconnects.
  const isBug = hasOverlap && !cur.ok
  if (isBug) bugs++

  const verdict = isBug
    ? `BUG (common=${common.join(",")} lost)`
    : hasOverlap
      ? "ok"
      : "ok (correctly rejected)"

  console.log(pad(c.name, 52) + pad(hasOverlap ? "yes" : "no", 10) + pad(curStr, 16) + pad(fixStr, 16) + verdict)
}
console.log("-".repeat(110))
console.log(`\nCurrent-algorithm correctness bugs (overlap existed but it disconnected): ${bugs}`)

// ---- End-to-end faithfulness check against the REAL Server class -----------
// Proves negotiateCurrent()'s server-side rule matches the shipped _oninitialize.
async function serverReturnsFor(requested: Version): Promise<Version> {
  const server = new Server({ name: "repro", version: "0.0.0" }, { capabilities: {} })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const result = await new Promise<any>((resolve, reject) => {
    clientT.onmessage = (m: any) => (m.result ? resolve(m.result) : reject(new Error(JSON.stringify(m.error))))
    clientT.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "c", version: "0" } },
    })
  })
  await server.close()
  return result.protocolVersion
}

console.log(`\nEnd-to-end check against real Server (SUPPORTED here = ${JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS)}):`)
const supportedProbe = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1] // an old, supported version
for (const req of [supportedProbe, "2099-01-01"]) {
  const got = await serverReturnsFor(req)
  const modeled = SUPPORTED_PROTOCOL_VERSIONS.includes(req) ? req : LATEST_PROTOCOL_VERSION
  const match = got === modeled ? "matches model" : "DIVERGES from model"
  console.log(`  requested ${req} -> real server returned ${got}  (${match})`)
}

process.exit(bugs > 0 ? 1 : 0)
