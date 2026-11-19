# Skoriva — Frontend Integration Contracts

> **Status:** verified against backend source (`apps/api`) and frontend
> implementation (T-31.1 … T-31.10).
> **Scope:** frontend integration foundation only. No product pages exist yet.
> Anything marked **GAP** is not implemented anywhere; do not treat it as done.

---

## 1. REST same-origin proxy

The browser never addresses the backend origin directly. `next.config.ts` proxies:

```text
/api/:path*  →  ${BACKEND_URL}/api/:path*
```

- The `:path*` remainder is forwarded unchanged, so the backend still receives
  `/api/...` (no prefix stripping, no double prefix).
- `BACKEND_URL` is a **server-only** variable: it is read in `next.config.ts`,
  never as `NEXT_PUBLIC_*`, and does not appear in `.next/static`.
- Reason: the account cookie is `SameSite=Lax` without a `domain` attribute, so it
  is only reliable same-site. The proxy keeps the browser on the web origin in
  development (`localhost:3000`) and production (Vercel → API host).

Cookie behaviour (verified end to end against a probe backend):

| Direction | Result |
|---|---|
| Browser → proxy → backend | request `Cookie` forwarded |
| Backend → proxy → browser | `Set-Cookie` forwarded |
| Browser | only relative `/api/*` requests |

## 2. Environment variables

Web (`apps/web/.env.local`, or the host dashboard):

| Variable | Visibility | Purpose |
|---|---|---|
| `BACKEND_URL` | server only | proxy target, read by `next.config.ts` |
| `NEXT_PUBLIC_SOCKET_URL` | browser | Socket.IO origin (no credentials in it) |

- Next.js runs from `apps/web`, so it reads env files **there**, not the repo root
  `.env` used by `apps/api`.
- Both values are validated by Zod (`src/lib/env.ts`); a missing or non-`http(s)`
  value fails fast at start/build.
- `BACKEND_URL` and `NEXT_PUBLIC_SOCKET_URL` are declared in `turbo.json`
  `build.passThroughEnv` so `turbo run build` forwards them.
- No secret (`MONGODB_URI`, `JWT_SECRET`, `TOKEN_PEPPER`) belongs in the web env.

## 3. REST error contract

Every backend error is `{ code, message }`; some add fields:

```json
{ "code": "VERSION_CONFLICT", "message": "…", "currentVersion": 12, "snapshot": { … } }
```

`ApiClientError` (`src/lib/api/api-error.ts`) normalises it:

| Field | Meaning |
|---|---|
| `status` | HTTP status (`0` for transport/abort failures) |
| `code` | backend code preserved verbatim, or a client code |
| `message` | safe Bahasa Indonesia copy |
| `currentVersion`, `snapshot` | preserved when the backend sends them |
| `isVersionConflict` | `409` + `VERSION_CONFLICT` |

Client-only codes: `NETWORK_ERROR`, `REQUEST_ABORTED`, `INVALID_RESPONSE_BODY`,
`INVALID_ERROR_BODY`. Unreadable bodies never leak their content into messages.

Verified backend codes include: `UNAUTHENTICATED`, `INVALID_CREDENTIALS`,
`EMAIL_ALREADY_REGISTERED`, `VALIDATION_ERROR`, `INVALID_JSON`, `NOT_FOUND`,
`UNTRUSTED_ORIGIN`, `FORBIDDEN`, `MATCH_NOT_FOUND`, `INVALID_MATCH_ID`,
`INVALID_EVENT_ID`, `INVALID_CONFIG`, `TX_ID_CONFLICT`, `MATCH_ALREADY_CLAIMED`,
`CONTEXT_UPDATE_FAILED`, `EVENT_NOT_FOUND`, `EVENT_FORBIDDEN`, `EVENT_ARCHIVED`,
`EVENT_HAS_DEPENDENCIES`, `EVENT_DEPTH_EXCEEDED`, `EVENT_OWNER_MISMATCH`,
`EVENT_OWNER_REQUIRED`, `EVENT_SPORT_MISMATCH`, `MATCH_EVENT_OWNER_MISMATCH`,
`MATCH_EVENT_SPORT_MISMATCH`, `PARENT_EVENT_NOT_FOUND`, `OPERATOR_SESSION_*`,
`HANDOVER_CODE_*`, `VIEW_CODE_REQUIRED`, `VIEW_CODE_INVALID`, `STATE_CONFLICT`,
`STATE_UPDATE_FAILED`, `LIFECYCLE_VIA_REST`, `JOIN_REQUIRED`.

## 4. Auth cookie behaviour

- Login sets an httpOnly cookie (`skoriva_session`), `SameSite=Lax`,
  `secure` in production, `path=/`, no `domain`, 7-day lifetime.
- The frontend never reads, stores, or echoes the JWT: no token appears in any
  response body, state, query key, or storage.
- `POST /api/auth/register` returns **201 without a cookie**: registering does not
  start a session (`RegisterAccountResult.sessionStarted === false`).
- `POST /api/auth/logout` returns 204 and clears the cookie server-side.

## 5. Auth / Event / Match service endpoints

All paths are relative to the proxy.

**Auth** — `src/features/auth/services/auth.client.ts`

| Function | Endpoint |
|---|---|
| `registerAccount` | `POST /api/auth/register` → 201 `PublicAccount` |
| `loginAccount` | `POST /api/auth/login` → 200 `PublicAccount` + cookie |
| `logoutAccount` | `POST /api/auth/logout` → 204 |
| `getCurrentSession` | `GET /api/auth/me` → `PublicAccount` / 401 |

`PublicAccount` = `{ id, email, createdAt, lastLoginAt? }` where `lastLoginAt` may
be **absent**, **`null`**, or an ISO string.

**Events** (account-authenticated) — `src/features/events/services/events.client.ts`

| Function | Endpoint | Response |
|---|---|---|
| `createEvent` | `POST /api/events` | `EventSummary` |
| `listEvents` | `GET /api/events` | `{ events }` |
| `getEvent` | `GET /api/events/:id` | `EventSummary` |
| `updateEvent` | `PATCH /api/events/:id` | `EventSummary` |
| `archiveEvent` | `POST /api/events/:id/archive` | `EventSummary` (`archived: true`) |
| `listEventMatches` | `GET /api/events/:id/matches` | `{ groups: [{ label \| null, matches }] }` |
| `listEventChildren` | `GET /api/events/:id/children` | `{ children }` |

`EventSummary` has `parentId`, `description`, `date` as **`null`** (not absent).
`ownerId` is derived server-side and never sent by the client.

**Matches** — `src/features/matches/services/matches.client.ts`

| Function | Endpoint | Auth |
|---|---|---|
| `createMatch` | `POST /api/matches` | owner token / account |
| `getMatchAsOperator` | `GET /api/matches/:id` | `X-Operator-Session` |
| `getMatchAsViewer` | `GET /api/matches/:id` | `X-View-Code` |
| `updateMatch` | `PATCH /api/matches/:id` | `X-Operator-Session` (READY only) |
| `listMatchEventLog` | `GET /api/matches/:id/events?limit&beforeSeq` | `X-Operator-Session` |
| `getPublicResult` | `GET /api/matches/:id/result` | `X-View-Code` |

Response shapes (verified against `match.serializers.ts`):

- operator detail → `{ match, state, display }`
- viewer detail → `{ display?, matchStatus, resultDecision }`; `display` is
  omitted while the result is not publicly visible
- event log → `{ events, nextBeforeSeq? }`
- public result → `display` only when `resultDecision === 'saved'`
- create → the above plus **`controlToken` and `viewCode` in plaintext, once**

`viewCode` is sent as the `X-View-Code` header, never `?code=`, so it stays out of
URLs, referrers, and access logs (R-03).

## 6. Socket.IO event contracts

Client types live in `src/lib/realtime/socket-contract.ts`. `@skoriva/shared`
does **not** export Socket.IO payloads, so these are client-side types verified
against `apps/api/src/realtime/{handlers,serializers,ticker}.ts`.

**Client → server**

| Event | Payload | Ack |
|---|---|---|
| `match:join` | `{ matchId, token?, viewCode?, lastVersion? }` | `{ ok: true, role }` |
| `match:action` | `{ matchId, txId, expectedVersion, type, payload }` | `{ version, txId }` |
| `clock.confirm` | `{ matchId, txId, expectedVersion, payload? }` | `{ version, txId }` |
| `match:leave` | `{ matchId }` | `{ ok: true }` |
| `operator:handover.create` | `{ matchId }` | `{ code, expiresAt }` |
| `operator:handover.accept` | `{ matchId, code }` | `{ active: true }` |
| `operator:rotate-token` | `{ matchId }` | `{ controlToken, issuedAt }` |
| `operator:rotate-view-code` | `{ matchId }` | `{ viewCode, issuedAt }` |
| `match:pong` | `{ ts? }` | `{ ts }` |

Failures arrive as `{ error: { code, message, currentVersion? } }`.

**Server → client**

| Event | Payload |
|---|---|
| `match:snapshot` | operator `{ matchId, version, state, display, serverTs }`; viewer `{ matchId, version, display?, matchStatus, resultDecision, serverTs }` |
| `match:patch` | same as snapshot, operator adds `event?` |
| `match:clock` | `{ matchId, clock: { remainingMs, isRunning, expired }, sportClock?, serverTs }` (1 Hz, live + timed only) |
| `match:status` | `{ matchId, matchStatus, resultDecision }` |
| `match:error` | `{ code, message, currentVersion?, snapshot? }` |
| `operator:state` | `{ active, actorRef?, graceUntil? }` |
| `operator:session` | `{ matchId, sessionId, credential?, expiresAt }` (private) |

`SocketClient` (`src/lib/realtime/socket-client.ts`) is created with
`autoConnect: false`; importing the module never opens a connection. Acks are
awaited with a bounded timeout and normalised to `AckResult`; `currentVersion`
and `snapshot` are preserved.

## 7. Operator credential separation

Two credentials, deliberately distinct:

| | `controlToken` | `sessionCredential` |
|---|---|---|
| Origin | `POST /api/matches` (201) | private `operator:session` event / `operator:handover.accept` |
| Purpose | ownership + first claim | REST `X-Operator-Session` proof + reconnect |
| Storage (server) | `access.controlTokenHash` | `access.operatorSession.credentialHash` |
| Rotated by | `operator:rotate-token` | never rotated; replaced only by handover |

`viewCode` is a third, separate credential: public viewer access only.

Frontend store: `src/lib/store/operator-credentials.store.ts` keeps
`controlToken`, `sessionCredential`, `sessionId`, `matchId`, `expiresAt` as
separate fields. **In-memory only** — no `persist` middleware, no
`localStorage`/`sessionStorage`, no cookies, no logging, never in a URL.

Transitions: `setInitialControlToken` (create-match), `setSessionCredential`
(first claim / refresh), `replaceSessionCredential` (handover),
`rotateControlToken` (rotation — leaves the session proof untouched), and
`clearSessionCredential` (revocation — drops the proof, keeps ownership).

## 8. Initial claim flow

```text
POST /api/matches            → 201 { …, controlToken, viewCode }   (shown once)
  createMatch() stores controlToken in the credential store (memory only)
  viewCode is returned to the caller and never stored
socket match:join { token: controlToken }
  → backend resolves controlToken, claims the single operator slot
  → ack { ok: true, role: 'operator' }
  → private operator:session { sessionId, credential, expiresAt }
  useMatchSession subscribes to operator:session
  → adoptOperatorSession(): no sessionId yet → setSessionCredential()
frontend state: controlToken (ownership) + sessionCredential (REST proof)
```

What is actually wired (verified by
`tests/dom/operator-credential-wiring.test.tsx` and
`tests/api/matches.client.test.ts`):

| Step | Implemented in |
|---|---|
| adopt `controlToken` from create-match | `createMatch()` in `matches.client.ts` |
| subscribe `operator:session` | `useMatchSession` (socket → store) |
| classify initial / handover / refresh | `adoptOperatorSession()` |
| read the latest proof at request time | `getSessionCredential()` |

`viewCode` stays separate: it is returned to the caller for link distribution and
is never written to the credential store, a query key, or storage.

If another operator is already active the claim fails with
`OPERATOR_SESSION_CONFLICT`.

### Operator revocation

`operator:state { active: false }` means this client is no longer the active
operator. The session proof is dropped (`clearSessionCredential`) while
`controlToken` — ownership, a different credential — is preserved so the operator
can reclaim the slot later. Cache isolation reacts automatically (§16).

## 9. Active session reconnect flow

- Socket reconnect within the 30 s grace window: `match:join { token:
  sessionCredential }` → `reconnectOperatorSession` succeeds and the grace window
  is cleared.
- **After a page refresh** the in-memory store is empty. Re-joining with
  `controlToken` fails with `OPERATOR_SESSION_CONFLICT` while the previous session
  is still active (the backend does not treat the control token as a way to steal
  an active session). This is intended behaviour, not a bug — see §18.
- The client re-joins on every `connect` event, so a dropped socket recovers its
  snapshot automatically.

## 10. Token rotation

`operator:rotate-token` → ack `{ controlToken, issuedAt }`.

- Only the **control token** is replaced; the active `sessionCredential` keeps
  working (verified in `apps/api/src/access/operator-session.ts`).
- The frontend `rotateControlToken` action updates `controlToken` and leaves
  `sessionCredential` untouched; a rotation aimed at a different `matchId` is
  ignored.

## 11. Handover

```text
active operator   → operator:handover.create  → ack { code, expiresAt } (TTL 2 min)
receiving operator→ operator:handover.accept  → ack { active: true }
                  → backend adopts the socket and emits a new operator:session
                  → old operator sockets receive operator:state { active: false }
```

The receiving operator replaces `sessionCredential` (and `sessionId`); the
`controlToken` is ownership and is not part of the handover.

## 12. Viewer access

- Route requirement: `/view/[matchId]?code=[viewCode]` and
  `/display/[matchId]?code=[viewCode]` (B-08). Not built in T-31.
- Service layer sends the code as `X-View-Code`, never in a query string.
- Viewer payloads never contain `state`, the event log, rosters, or statistics
  (B-07). `display` is omitted for `undecided`, `discarded`, and `cancelled`.
- Rotating the view code disconnects existing viewer sockets (R-04).

## 13. Snapshot and patch version behaviour

`src/features/match-session/store/match-session.store.ts`:

- `match:snapshot` replaces local state (authoritative sync).
- `match:patch` applies only when `version > currentVersion`; stale or duplicate
  patches are ignored.
- The backend always sends **full** snapshots — there are no independent deltas,
  so patches must never be treated as partial merges.
- No optimistic mutation: the store changes only on server data.
- **Realtime `VERSION_CONFLICT` recovery**: the acknowledgement carries only
  `currentVersion`; the authoritative `snapshot` arrives on the `match:error`
  broadcast. `useMatchSession` applies it through `resyncFromSnapshot()`, which
  ignores a snapshot whose `version` is not newer than local state. The error is
  recorded **after** the resync so it stays visible to the caller. A
  `VERSION_CONFLICT` without a snapshot never fabricates state.
- REST lifecycle conflicts (`409 VERSION_CONFLICT`) **do** include
  `currentVersion` + `snapshot` in the response body; `ApiClientError` preserves
  both.
- `lastVersion` in `match:join` is accepted by the backend but **delta recovery is
  not implemented**; a full snapshot always follows.

## 14. Clock and recovery behaviour

- Server is authoritative: 1 Hz `match:clock` for live + `timed` matches only.
- `useMatchClock` interpolates locally for **display only**; the value is never
  sent back and never stored as authoritative state.
- Interpolation stops when the server reports `isRunning: false` or `expired`, and
  when `recoveryPending` is true.
- Every snapshot/patch/clock update re-anchors the interpolation.
- B-11: when `state.clock.recoveryPending` is true the clock is frozen; the
  operator must send `clock.confirm` before it resumes. There is no auto-resume.

## 15. Query state vs Zustand realtime state

| Data | Owner |
|---|---|
| Auth session, events, event detail, match metadata (REST) | TanStack Query |
| Match snapshot/patch, clock, version, connection, operator availability | Zustand (`match-session`) |
| Operator credentials | Zustand (`operator-credentials`) |
| Theme | `next-themes` |

Realtime match state is **not** placed in the query cache, and query data is not
mirrored into the match store.

## 16. Query cache isolation

`src/lib/query/operator-cache.ts` + `src/features/match-session/operator-cache-isolation.ts`:

- installed **automatically** by `QueryProvider` (no component or UI calls it);
- operator-scoped keys are `['matches','events',matchId,…]` and
  `['matches','detail',matchId]`;
- they are removed when credentials are cleared, the active match changes, the
  operator session is replaced (handover), or operational rights are revoked
  (`operator:state { active: false }`);
- public viewer data (`['matches','result',matchId]`) and account data are kept;
- query keys never contain credentials, so isolation is explicit, not implicit.

## 17. Theme behaviour

`src/providers/theme-provider.tsx` wraps `next-themes` with:

```text
attribute="class"  defaultTheme="system"  enableSystem
storageKey="skoriva-theme"  disableTransitionOnChange
```

- `attribute="class"` matches `@custom-variant dark (&:is(.dark *))` in
  `globals.css`.
- Anonymous preference persists in `localStorage`; with no stored preference the
  device `prefers-color-scheme` wins.
- No theme toggle UI exists yet (later product task).

## 18. Known backend gaps

| # | Gap | Impact |
|---|---|---|
| 1 | `GET /api/history` is not implemented | Match History cannot be built; `endpoints` deliberately omits it |
| 2 | No account theme preference field/endpoint | Logged-in theme preference is **not** synchronised; only `localStorage` + system |
| 3 | `/create` vs `/quick-match` route ownership is undecided | Both routes exist as placeholders; the split is a product decision |
| 4 | OQ #1 — anonymous operator credential recovery is unresolved | After refresh the operator loses both credentials; no recovery mechanism exists and none was invented |

### Deliberate limitations of this foundation

- No product pages, navigation, or UI components were created.
- No token recovery, no credential persistence, no `sessionStorage` fallback.
- `match:join.lastVersion` is sent but unused by the backend (no delta recovery).
- Theme preference for logged-in accounts is a documented gap, not a feature.
- `match:leave` is **not** sent on component unmount. Leaving is a session
  decision, not a React lifecycle event: sending it on unmount (including React
  StrictMode double-mounts) would start the 30 s grace window and churn the
  operator lock. A real socket disconnect already triggers the same server path.
- `getSessionCredential()` must be called at request time; reading it at module
  import or capturing it in a closure would go stale after rotation/handover.
