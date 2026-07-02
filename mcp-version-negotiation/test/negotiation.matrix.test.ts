import { describe, it, expect } from "vitest"
import {
  selectProtocolVersion,
  serverNegotiate,
  clientInitializeParams,
  clientAccept,
  type ProtocolVersion,
} from "../src/selectProtocolVersion.js"

const latest = (s: ProtocolVersion[]) => [...s].sort().at(-1)!
const overlapMax = (a: ProtocolVersion[], b: ProtocolVersion[]) => {
  const common = a.filter((v) => b.includes(v)).sort()
  return common.length ? common.at(-1)! : null
}

/** Full new-client <-> new-server handshake using the proposed fix. */
function handshake(client: ProtocolVersion[], server: ProtocolVersion[]) {
  const clientLatest = latest(client)
  const serverLatest = latest(server)
  const params = clientInitializeParams(client, clientLatest)
  const res = serverNegotiate(params, server, serverLatest)
  if (!res.ok) return { ok: false as const }
  return { ok: clientAccept(res.protocolVersion, client), version: res.protocolVersion }
}

const TIMELINE = ["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"]

function nonEmptySubsets<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let mask = 1; mask < 1 << items.length; mask++) {
    out.push(items.filter((_, i) => mask & (1 << i)))
  }
  return out
}

describe("protocol version negotiation = set intersection", () => {
  it("selects the highest common version; disjoint sets yield null", () => {
    expect(selectProtocolVersion(["2025-06-18", "2025-11-25"], ["2025-03-26", "2025-11-25"])).toBe("2025-11-25")
    expect(selectProtocolVersion(["2026-07-28", "2025-03-26"], ["2025-03-26", "2025-11-25"])).toBe("2025-03-26")
    expect(selectProtocolVersion(["2026-07-28"], ["2024-10-07"])).toBeNull()
  })

  it("regression: gappy sets that the shipped two-probe algorithm loses", () => {
    // GAPPY client: shipped algo disconnects; correct answer is 2025-03-26.
    expect(handshake(["2026-07-28", "2025-03-26"], ["2025-03-26", "2025-06-18", "2025-11-25"])).toEqual({
      ok: true,
      version: "2025-03-26",
    })
    // GAPPY server: shipped algo disconnects; correct answer is 2024-11-05.
    expect(handshake(["2024-11-05", "2025-11-25"], ["2026-07-28", "2024-11-05"])).toEqual({
      ok: true,
      version: "2024-11-05",
    })
  })

  it("exhaustive: for every pair of supported sets, overlap ⇒ success at max(overlap)", () => {
    const subsets = nonEmptySubsets(TIMELINE)
    let pairs = 0
    for (const client of subsets) {
      for (const server of subsets) {
        pairs++
        const expected = overlapMax(client, server)
        const got = handshake(client, server)
        if (expected === null) {
          expect(got.ok, `disjoint ${client} / ${server} must fail`).toBe(false)
        } else {
          expect(got, `overlap ${client} / ${server}`).toEqual({ ok: true, version: expected })
        }
      }
    }
    expect(pairs).toBe(subsets.length * subsets.length)
  })

  it("backward compatible: old client (no supportedVersions) uses legacy path", () => {
    const server = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
    // Old client requests a version the server supports -> echoed.
    expect(serverNegotiate({ protocolVersion: "2025-06-18" }, server, "2025-11-25")).toEqual({
      ok: true,
      protocolVersion: "2025-06-18",
    })
    // Old client requests an unknown version -> server falls back to its latest.
    expect(serverNegotiate({ protocolVersion: "2099-01-01" }, server, "2025-11-25")).toEqual({
      ok: true,
      protocolVersion: "2025-11-25",
    })
  })
})
