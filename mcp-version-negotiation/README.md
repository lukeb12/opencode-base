# MCP protocol-version negotiation: overlap handshake

Prototype + repro for a correctness bug in MCP client/server protocol-version
negotiation, plus a backward-compatible fix and a CI conformance test.

**This bundle is destined for `modelcontextprotocol/typescript-sdk`.** It is
prototyped here (in `opencode-base`, which already depends on
`@modelcontextprotocol/sdk`) so it can be run and validated end-to-end; the
intent is to lift it into an upstream PR.

## The bug

Negotiation is a **lossy two-probe exchange, not a set intersection** (verbatim
from `@modelcontextprotocol/sdk@1.29.0`):

- `server/index.ts` `_oninitialize`: `SUPPORTED.includes(requested) ? requested : LATEST` — echo the client's version or return the **server's own latest**.
- `client/index.ts` `connect`: sends its **own latest**; on reply, `if (!SUPPORTED.includes(returned)) throw "Server's protocol version is not supported"`.

So each side probes exactly two points — client-latest, then server-latest — and
gives up. This is **provably correct only when each side's supported set is a
contiguous range** `[min, latest]`. It **fails on gappy sets** (a deprecated
middle version, an endpoint pinned to specific tested versions, LTS + bleeding
edge with nothing between) even though a common version exists.

### Confirmed against the real SDK (`repro.ts`)

```
case                                                overlap?  current       intersection   verdict
GAPPY client (dropped middle versions)              yes       DISCONNECT    OK 2025-03-26  BUG (common=2025-03-26 lost)
GAPPY server (LTS + bleeding edge, nothing between) yes       DISCONNECT    OK 2024-11-05  BUG (common=2024-11-05 lost)
truly disjoint (no common version)                  no        DISCONNECT    DISCONNECT     ok (correctly rejected)
```

An end-to-end check drives the real `Server` class over `InMemoryTransport` and
confirms `_oninitialize` returns exactly what the model predicts — this is the
shipped algorithm, not a strawman.

## The invariants (why "overlap" is the correctness condition)

A session is an ordered message trace under `seq`. Correctness needs:

1. **Existence / liveness** — `intersection(clientSupported, serverSupported) ≠ ∅`
   is *necessary*, and negotiation MUST succeed whenever it holds. (The shipped
   algorithm violates this.) Empty intersection ⇒ fail fast, deterministically.
2. **Agreement / immutability** — both endpoints select the *same* element via a
   deterministic choice function (`max` by version order), frozen for the whole
   trace: `negotiate ⟶ v* ⟶ ∀ m ∈ seq: interpret(m, v*)`. (The transport's
   existing `setProtocolVersion` already pins it per session; the fix only makes
   *selection* complete.)

MCP versions are `YYYY-MM-DD`, so lexicographic order == chronological order and
`max(intersection)` is just the greatest common string.

## The fix (`src/selectProtocolVersion.ts`) — backward compatible

Add an **optional** `supportedVersions: string[]` to the `initialize` params:

- **Client** sends `{ protocolVersion: <latest>, supportedVersions: SUPPORTED }`.
  `protocolVersion` is retained so **old servers** still work.
- **Server**: if `supportedVersions` is present ⇒ return
  `max(intersect(server.SUPPORTED, supportedVersions))`, or fail with
  `no overlapping protocol version` if disjoint. If absent ⇒ **unchanged** legacy
  two-probe path.
- **Client** acceptance check is unchanged (returned version ∈ its supported set).

Compatibility matrix:

| client | server | behaviour |
|--------|--------|-----------|
| new | new | correct `max(intersection)` |
| new | old | old server ignores `supportedVersions` → legacy path, no regression |
| old | new | no `supportedVersions` present → legacy path, no regression |
| old | old | unchanged |

## Files

- `src/selectProtocolVersion.ts` — reference implementation (selection + server/client helpers).
- `test/negotiation.matrix.test.ts` — vitest suite: unit + gappy regressions + an
  **exhaustive 63×63 sweep** (all non-empty subsets of the 6-version timeline)
  asserting `overlap ⇒ success at max(overlap)`, plus a backward-compat test.
- `repro.ts` — runnable demonstration against the real installed SDK.
- `.github/workflows/protocol-compat.yml` — CI job that runs the conformance suite.

## Run it

```bash
# in a project with @modelcontextprotocol/sdk + vitest installed
bun repro.ts                                   # demonstrate the bug (exits 1 while bugs exist)
npx vitest run test/negotiation.matrix.test.ts # conformance suite (green with the fix)
```

## Suggested upstream shape

1. Wire the `supportedVersions` field into the `InitializeRequest` schema (optional).
2. Replace the `_oninitialize` ternary and the client accept-check with the
   helpers in `src/selectProtocolVersion.ts`.
3. Add the conformance suite + CI job.
4. Spec side (separate track): this is the concrete case for **SEP-1400 (semver)**
   / **SEP-1309 (version management)** — semver ranges make "supported set"
   contiguous by construction, turning overlap into range intersection.
