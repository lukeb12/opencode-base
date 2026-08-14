/**
 * Protocol-version negotiation as a set intersection (proposed fix).
 *
 * The shipped SDK negotiates with a lossy two-probe exchange: the client sends
 * only its LATEST version, and the server echoes it or falls back to the
 * server's LATEST. That misses an existing common version whenever either
 * side's supported set is non-contiguous ("gappy").
 *
 * The fix: the client advertises its full supported set, and the server (or
 * client) selects max(intersection). MCP versions are YYYY-MM-DD strings, so
 * lexicographic order == chronological order and `max` is just the greatest
 * string. Backward compatible: the new `supportedVersions` field is optional
 * and old peers ignore it, falling back to the legacy path with no regression.
 */

export type ProtocolVersion = string

/** Highest common protocol version, or null if the two sets are disjoint. */
export function selectProtocolVersion(
  clientSupported: ProtocolVersion[],
  serverSupported: ProtocolVersion[],
): ProtocolVersion | null {
  const serverSet = new Set(serverSupported)
  const common = clientSupported.filter((v) => serverSet.has(v)).sort()
  return common.length ? common[common.length - 1]! : null
}

export interface InitializeVersionParams {
  /** Legacy single value; kept so new clients still work against old servers. */
  protocolVersion: ProtocolVersion
  /** New: the client's full supported set. Absent from old clients. */
  supportedVersions?: ProtocolVersion[]
}

export type ServerNegotiationResult =
  | { ok: true; protocolVersion: ProtocolVersion }
  | { ok: false; reason: string; serverSupported: ProtocolVersion[] }

/** Server-side decision. New path when the client advertised a set; otherwise
 *  the unchanged legacy two-probe behaviour. */
export function serverNegotiate(
  params: InitializeVersionParams,
  serverSupported: ProtocolVersion[],
  serverLatest: ProtocolVersion,
): ServerNegotiationResult {
  if (params.supportedVersions && params.supportedVersions.length) {
    const chosen = selectProtocolVersion(params.supportedVersions, serverSupported)
    if (chosen) return { ok: true, protocolVersion: chosen }
    return { ok: false, reason: "no overlapping protocol version", serverSupported }
  }
  // Legacy path (old clients): identical to the shipped _oninitialize.
  const chosen = serverSupported.includes(params.protocolVersion) ? params.protocolVersion : serverLatest
  return { ok: true, protocolVersion: chosen }
}

/** What a new client puts on the wire. `protocolVersion` retained for old servers. */
export function clientInitializeParams(
  clientSupported: ProtocolVersion[],
  clientLatest: ProtocolVersion,
): InitializeVersionParams {
  return { protocolVersion: clientLatest, supportedVersions: clientSupported }
}

/** Client acceptance check (unchanged invariant: must be a version we support). */
export function clientAccept(returned: ProtocolVersion, clientSupported: ProtocolVersion[]): boolean {
  return clientSupported.includes(returned)
}
