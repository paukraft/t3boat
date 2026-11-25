# T3 Code remote-environment protocol (v0.1.10-nightly.20261114.4669)

This is the spec for a sleep-aware localhost proxy that sits between the T3 Code desktop app and a remote `t3 serve`.

- Paths are relative to the `t3src` checkout.
- `C:` means `packages/contracts/src`, `CR:` means `packages/client-runtime/src`, and `S:` means `apps/server/src`.
- Effect RPC envelope shapes come from effect@4.1.4 `src/rpc/RpcMessage.ts`. The repo pins 4.1.2 (`pnpm-workspace.yaml:47-51`). Diff the envelopes against 4.1.2 if exact bytes matter.

---

## 0. TL;DR design constraints

1. **Serve at the root path.** The pairing URL is normalized to root: `pathname="/"` (`packages/shared/src/remote.ts:110-131`). The proxy cannot live under a sub-path.
2. **Report the upstream `environmentId` everywhere.** The client checks it in three places:
   - the descriptor on every connect (`CR:connection/driver.ts:173-192`, `CR:authorization/service.ts:184-235`)
   - the first `subscribeServerConfig` snapshot: `config.environment.environmentId === connection.environmentId` (`CR:rpc/session.ts:369-385`)
   - on a mismatch the client is blocked with `environmentMismatchError` (`CR:connection/errors.ts:28-36`)
3. **Never answer 401, 403 or 404 on the auth and ticket routes while the host sleeps.** Those map to `ConnectionBlockedError`, which does not retry until a wakeup (`CR:connection/errors.ts:180-221`). Answer the request from cache, or answer 5xx (transient, with backoff).
4. **Keep the WebSocket alive while the host sleeps.** Answer `Ping` with `Pong`, and never end the `subscribeServerConfig` stream. If that stream ends, even successfully, the client tears the session down (`CR:rpc/session.ts:352-357, 468-471`). Dropping the socket instead puts the client on exponential backoff of up to 5 min (§5), which makes the wake slow to show up in the UI.
5. **Strip `directEndpoints` from every `ServerConfig` you forward.** The field is `C:server.ts:695`. The client learns LAN and tailnet routes from it and connects to them directly, bypassing the proxy (`CR:connection/supervisor.ts:352-370`, `CR:connection/routes.ts:232-300`).
6. **Rewrite `config.serverTime` to now when you replay a cached config.** The client uses it as its clock-skew reference (`CR:rpc/session.ts:337-347`).
7. **Answer CORS yourself.** The renderer origin is `t3code://app` (`S:httpCors.ts:13`). The server sends wildcard CORS (`S:http.ts:256-273`):
   - methods `GET, POST, OPTIONS`
   - headers `authorization, b3, traceparent, content-type, dpop, x-t3-orchestration-protocol`
   - `maxAge` 600

   The proxy must answer `OPTIONS` itself while the host sleeps.

---

## 1. Adding a remote environment to the desktop app

### 1.1 Deep link `t3code://pair?pairingUrl=<urlencoded>`

**Registration**
- electron-builder registers the schemes `t3code` and `t3code-dev` (`scripts/build-desktop-artifact.ts:2871-2875`).
- macOS dev launcher: `apps/desktop/scripts/electron-launcher.mjs:20,187,286`.
- Linux: `apps/desktop/src/app/DesktopLinuxUrlHandler.ts:94,291`.

**Main process** (`apps/desktop/src/app/DesktopClerk.ts`)
- The `open-url` (`:138`) and `second-instance` (`:129`) events queue the link.
- `openAppLink` (`:217-222`) accepts it only if `readPairingAppLink(url) !== null`.
- `DesktopWebLinks.ts:29-78` holds it until the renderer is ready, then sends `WEB_LINK_OPEN_CHANNEL` (`:47`).

**Renderer** (`apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx`)
- It only subscribes once the local primary environment is connected, or once the local environment is disabled (`:102-106`).
- `pairFromLink` (`:122-147`) always asks for confirmation: `requestConfirmDialog("Add the backend at ${origin}?")`.
- It then calls `connectPairingEnvironment({pairingUrl})` and shows the toast "Backend added".

**Parsing** (`packages/shared/src/remote.ts`)
- `readPairingAppLink` (`:195-201`) requires the scheme to match `/^t3code(?:-[a-z]+)?:$/`, the host to be `pair`, and the path to be empty or `/`. It reads the `pairingUrl` query parameter.
- `resolveRemotePairingTarget` (`:203-260`) handles the pairing URL:
  - Allowed protocols are `http: https: ws: wss:` (`:8`).
  - The token comes from fragment `#token=` first, then from query `?token=` (`:146-154`).
  - Hosted form: `?host=&token=&label=`. A `host` without a scheme defaults to `https://` (`:87-89,174`).
- The canonical form, which the server emits, is `http://HOST:PORT/pair#token=XXX` (`S:auth/EnvironmentAuth.ts` `issueStartupPairingUrl`, `S:startupAccess.ts:153-159`).
- **Manual entry** (Settings → Add environment) accepts a URL or host plus code (`apps/web/src/components/settings/ConnectionsSettings.logic.ts:236-286`). Input without a scheme gets `https://` (`:243-246`), so type `http://localhost:PORT` explicitly.

### 1.2 Loopback and plain HTTP

Neither is rejected.
- Loopback is classified as route kind `"loopback"` with the label "This device" (`CR:connection/routes.ts:85,193-194`; `packages/shared/src/hostClassification.ts:76-80`).
- It counts as trusted, the same as https: `routeKeepsItsHost` (`routes.ts:116-119`).
- Loopback is filtered only out of *learned* routes (`routes.ts:267-268`).
- The plain-HTTP rules apply only to routes that borrow a credential (`routes.ts:340-377`).
- `http://localhost:PORT` works as a paired remote.

**Collisions** (`CR:connection/onboarding.ts:101-163`, `CR:connection/registry.ts:544-602`)
- If the descriptor's id belongs to the desktop's own local environment, `register` returns `false` and nothing is saved. The pairing code is still spent and the toast still says "added".
- If the id is already saved at another address, pairing fails with: "That address claims to be X, which is already saved. Add it as a route…"
- So remove any existing direct entry for the upstream machine before pairing the proxy.
- Alternatively, keep the proxy as a route of that saved machine: use **Add route**, and drag the proxy route first.

### 1.3 Pairing HTTP exchange (client → server)

All endpoints are in `C:environmentHttp.ts:584-627`; the client calls are in `CR:authorization/remote.ts`.

1. **`GET /.well-known/t3/environment`**
   - No auth, 10 s timeout (`CR:environment/descriptor.ts:13`).
   - Returns `ExecutionEnvironmentDescriptor` (`C:environment.ts:211-219`):
     ```json
     {"environmentId":"…","label":"vps","platform":{…},"serverVersion":"0.1.10-nightly.20261114.4669",
      "orchestrationProtocolVersion":2,"databaseMigration":123,"capabilities":{…}}
     ```
   - The client checks the expected id, the known-address rule and protocol compatibility (`CR:connection/compatibility.ts`).
2. **`POST /oauth/token`**
   - Body is `application/x-www-form-urlencoded` (`C:auth.ts:220-229`); built by `bootstrapRemoteBearerSession` (`remote.ts:145-170`). No `dpop` header for direct pairing.
     ```
     grant_type=urn:ietf:params:oauth:grant-type:token-exchange
     &subject_token=<pairing token>
     &subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
     &requested_token_type=urn:ietf:params:oauth:token-type:access_token
     [&scope=…&client_label=…&client_device_type=…&client_os=…]
     ```
   - Response `AuthAccessTokenResult` (`C:auth.ts:232-238`):
     ```json
     {"access_token":"<opaque>","issued_token_type":"urn:ietf:params:oauth:token-type:access_token",
      "token_type":"Bearer","expires_in":2592000,"scope":"orchestration:read orchestration:operate …"}
     ```
     Newer servers add `permissions` (`docs/internals/environment-auth.md:93-99`).
   - A bearer token lasts 30 days: `DEFAULT_SESSION_TTL` (`S:auth/SessionStore.ts:448`). There is no refresh token. The client keeps only `access_token` (`onboarding.ts:149-151`).
3. The client then connects (§3).

### 1.4 What the desktop stores, and where

**File:** `~/.t3/userdata/connection-catalog.json`, or `$T3CODE_HOME/userdata/…` (`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:386`, `DesktopStatePaths.ts:13-31`).

**On disk:** `{"version":1,"encryptedCatalog":"<base64 safeStorage.encryptString(json)>"}`.
- The encryption key lives in the macOS Keychain (`DesktopConnectionCatalogStore.ts:29-32,398-421`).
- With no safeStorage available, `get` returns none and `set` does not write (`:470-472,490-492`).

**Decrypted document:** `ConnectionCatalogDocument` (`CR:platform/storageDocument.ts:20-32`, `CR:connection/catalog.ts:19-65`, `CR:connection/model.ts:19-25`).
```json
{"schemaVersion":1,
 "targets":[{"_tag":"BearerConnectionTarget","environmentId":"E","label":"vps","connectionId":"bearer:E:http://localhost:4000"}],
 "profiles":[{"_tag":"BearerConnectionProfile","connectionId":"bearer:E:http://localhost:4000","environmentId":"E","label":"vps",
              "httpBaseUrl":"http://localhost:4000/","wsBaseUrl":"ws://localhost:4000/"}],
 "credentials":[{"connectionId":"bearer:E:http://localhost:4000","credential":{"_tag":"BearerConnectionCredential","token":"<access_token>"}}],
 "remoteDpopTokens":[],"disabledEnvironmentIds":[]}
```
- The connection id is `bearer:${environmentId}:${origin}` (`onboarding.ts:90-92`).
- Extra routes are extra target and profile pairs that share `environmentId`.

**Writing the file directly** is impractical: it needs the app's safeStorage key.
- A legacy plaintext import (`~/.t3/userdata/saved-environments.json`, `apps/desktop/src/settings/DesktopSavedEnvironments.ts:43-58`) runs only when `connection-catalog.json` is absent.
- The token in that import must still be safeStorage-encrypted (`:267-283`).
- An entry imported without a token appears in the app but fails authentication (`DesktopConnectionCatalogStore.ts:332-365,423-469`).

### 1.5 Non-interactive registration

There is none.
- `t3 environment link|list|unlink` (`S:cli/environment.ts:85-171`) is server-to-server peer linking (MCP). It does not touch the desktop catalog.
- `t3 app` (`S:cli/app.ts:272-281`) only supports `open-workspace` (`C:desktopAppActivation.ts:10-14`).
- `t3 pair` prints `App link: t3code://pair?pairingUrl=…` (`S:cli/pair.ts:215`) but has no `--open` flag.

**Best automation:**
```sh
open 't3code://pair?pairingUrl=http%3A%2F%2Flocalhost%3A4000%2Fpair%23token%3D<tok>'
```
The user clicks Confirm once.

---

## 2. HTTP endpoints the client calls

`OrchestrationProtocolHeaders` (`C:environmentHttp.ts:103-107`) means `authorization` plus `x-t3-orchestration-protocol: 2` (`C:environment.ts:13-16`, `CR:state/environmentHttpAuth.ts:33-37`). The server also gzips responses (`S:http.ts:252`).

| Method + path | Auth | Purpose | While asleep |
|---|---|---|---|
| `GET /.well-known/t3/environment` | none | descriptor / host check before every connect and route preflight | **must answer**: cached descriptor |
| `POST /oauth/token` (form) | none | pairing exchange | proxy's own pairing (§7) |
| `GET /api/auth/session` | Bearer | `AuthSessionState` `{authenticated, auth, scopes, permissions, sessionMethod, expiresAt}` (`C:auth.ts:509-516`) | cache |
| `POST /api/auth/websocket-ticket/rpc` | Bearer | `{ticket, expiresAt}` (`C:auth.ts:241-254`); ticket TTL 5 min (`SessionStore.ts:449`). A 404 here makes the client retry the bare path, and a 404 there blocks the client (`remote.ts:191-234`). | **must answer**: mint a local ticket |
| `POST /api/auth/websocket-ticket/media` | Bearer | ticket for device hub and preview stream. Not single-use: one ticket serves every request of a stream for its 5 min. The client asks for a new one after every failed stream connect. | **must answer**: mint a local ticket (minting upstream would wake the machine on every retry) |
| `GET /api/orchestration/shell?omitIdleSubagents=&omitOlderSettled=&resumeFrom=` | Bearer + proto | `OrchestrationV2ShellHttpSnapshot`, or `{resumable:true}` (`C:orchestrationV2.ts:2322-2342`) | cache. The client waits only 3 s for it (`CR:state/shell.ts:95-98`). |
| `GET /api/orchestration/threads/:id` | Bearer + proto | thread detail snapshot (only older servers; current clients ask for the bounded one) | wake |
| `GET /api/orchestration/threads/:id/bounded?deferWork=&compactTurnItems=&dedupeBodies=&compactIds=` | Bearer + proto | bounded snapshot | the chat stored at sleep, in the encoding the client asks for; else wake |
| `GET /api/orchestration/threads/:id/history?cursor=…` | Bearer + proto | history page (older turns, a folded work section) | wake: that data only lives on the machine |
| `GET /api/orchestration/threads/:id/transcript` | Bearer + proto | transcript | wake |
| `GET /api/projects`, `POST /api/projects/mutate` | Bearer | project snapshot / mutation | wake |
| `POST /api/pull-requests/diff` | Bearer | PR diff | wake |
| `GET /api/assets/<token>/<name>` | URL token | media and files. `assets.createUrl` returns a **relative** URL (`S:assets/AssetAccess.ts:874`) | cache bytes, or 503 |
| `POST /api/attachments/upload/<token>` | URL token | attachment upload (`S:assets/AttachmentUpload.ts:36,115`) | wake |
| `/api/device-hub/*`, `/api/preview-stream/*` | media ticket (`?wsTicket=`), or Bearer | live device and browser streams (`S:device/DeviceHubProxy.ts`, `S:preview/ServerBrowserStream.ts`): plain requests (MJPEG, SSE, upload up to 100 MB) and WebSockets with text and binary frames. Upstream accepts `Authorization: Bearer` alone on the upgrade. The preview client reads close codes 4404 (tab closed), 4503 and 1012, and acks every frame with `{"type":"ack"}`. | live only: 503, never a wake |
| `POST /api/observability/v1/traces` | Bearer (operate) | renderer trace export (`S:http.ts:58,335`) | answer 200 and drop |
| `GET /ws/voice` | media ticket (`?wsTicket=`), operate scope | dictation stream (`S:speech/stream.ts`) | wake: a person opened it |
| `GET /api/preview/tunnel?port=` | media ticket (`?wsTicket=`), operate scope | one TCP connection to a loopback port on the machine, raw bytes over a WebSocket (`S:preview/PreviewTunnel.ts`). A port nothing listens on gets 403 with `x-t3-tunnel-port-refused: 1`; turned off, 403 with `x-t3-tunnel-disabled: 1`. The desktop app opens one on its own with every connection to a probe port of its own (`sharesLoopback` in `apps/desktop/src/preview/LoopbackTunnel.ts`): the refused header means "another machine"; any other failure is unknown and retried with backoff up to 30 s (`apps/web/src/state/portForwards.ts`). | live only; asleep: 403 with the refused header, never a wake |
| `/api/voice/*`, `/api/connect/*`, `/api/t3-connect/*` | Bearer | voice and T3 Connect management | live only, except `GET /api/voice/status`: the client sends it on its own once per connection and again on a mic click, so serve the last answer and wake only when there is none |
| `GET /ws` | ticket / Bearer / cookie | RPC socket (§3) | proxy terminates it |
| `/mcp`, `/oauth/mcp/{register,decision,token}` | MCP OAuth | linked environments (§10): another T3 server links to this one and calls its tools | relay; see §10 |
| `/oauth/mcp/authorize`, `/.well-known/oauth-*` | MCP OAuth | outside MCP clients only; neither the desktop UI nor a linking T3 server uses them | n/a |

---

## 3. WebSocket

### 3.1 URL and authentication

The client builds the URL in `CR:authorization/remote.ts:262-303` and `CR:connection/compatibility.ts:39-43`, then appends `frameParts=1` (`CR:rpc/session.ts:238-239`):
```
ws://HOST:PORT/ws?wsTicket=<ticket>&clientSurface=…&clientAppVersion=…&clientDeviceType=desktop&clientOs=…
   &connectionMethod=direct[&clientOwner=…]&orchestrationProtocol=2&clientCapabilities=settingsSecretReferences&frameParts=1
```

The server side is `S:ws.ts:3549-3640`.
- If `orchestrationProtocol !== "2"`, the server answers HTTP 426 `{code:"orchestration_protocol_incompatible",…}`.
- `authenticateWebSocketUpgrade` (`S:auth/EnvironmentAuth.ts:1470-1528`) checks the `wsTicket` query parameter first. The ticket must have audience `rpc` or no audience.
- Otherwise it falls back to `authenticateRequest` (`:839-890`), which accepts:
  - the session cookie
  - **`Authorization: Bearer <token>` header**, which suits a Node upstream client
  - `Authorization: DPoP` plus proof
- A browser cookie is also checked against `Origin`. Bearer and ticket authentication are not.
- MCP-client sessions are rejected on `/ws` (`rejectMcpClientAudience`).
- After the handshake, every RPC is scope-checked by `RpcAuthorization` (`S:auth/RpcAuthorization.ts:40-306`).

### 3.2 Framing

- **Serialization:** `RpcSerialization.layerJson` (`S:ws.ts:3618`, `CR:rpc/session.ts:274`).
  - One text frame holds one JSON message.
  - The decoder also accepts a JSON array of messages (effect `RpcSerialization.ts:141-152`).
- **Frame parts:** with `frameParts=1`, the server splits frames larger than 48 KiB (`packages/shared/src/socketFrameParts.ts:6-56`).
  - Every part except the last is prefixed with `\u001e`.
  - The receiver concatenates all parts, stripping the prefixes, then parses the whole.
  - The proxy must join parts from upstream. When talking to the desktop, it may either split again or send whole frames; the client handles both.
- **Compression:** `permessage-deflate` is on (`S:server.ts:379-383`). It is ordinary WS-level compression with no app-level encryption or compression. Any standard `ws` library handles it.
- **No server hello.** The server sends nothing until the client sends a request.

**Envelopes** (effect `RpcMessage.ts:76-517`; `id` comes from a global numeric counter in `RpcClient.ts:208,262`)

Client to server:
```json
{"_tag":"Request","id":7,"tag":"subscribeServerConfig","payload":{"environmentThemes":true,"providerStatusDeltas":true},"headers":[]}
{"_tag":"Ack","requestId":7}                 // sent after EVERY Chunk; the server windows streams on acks
{"_tag":"Interrupt","requestId":7,"interruptors":[]}  // cancels a stream or call
{"_tag":"Ping"}                              // every 5 s; the client drops the socket after 15 s with no inbound frame
{"_tag":"Eof"}
```

Server to client:
```json
{"_tag":"Chunk","requestId":7,"values":[{"version":1,"type":"snapshot","config":{…}}]}
{"_tag":"Exit","requestId":8,"exit":{"_tag":"Success","value":{}}}                    // unary result
{"_tag":"Exit","requestId":9,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentScopeRequiredError",…}}]}}
{"_tag":"Exit","requestId":9,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":null}]}}
{"_tag":"Pong"}
{"_tag":"Defect","defect":…}   {"_tag":"ClientProtocolError",…}
```

- **Flow control** (`S:terminal/OutputProtocol.ts:13-31`): the server waits for `Ack` before sending more chunks.
  - Terminal streams: at most 8 chunks or 64 KiB pending.
  - `subscribeServerConfig`, `subscribeShell` and `subscribeThread`: windowed by count.
  - So the proxy must relay `Ack`s upstream. For streams it serves itself, it may ignore them.
- **Liveness:** `PING_TIMEOUT = "15 seconds"` (`CR:rpc/protocol.ts:10-12`). Joined frame parts count as frames.

### 3.3 Connect and ready sequence

This is what the proxy must satisfy while the host sleeps.
1. `GET /.well-known/t3/environment`, then `POST /api/auth/websocket-ticket/rpc`, then the WS upgrade.
2. The client sends `subscribeServerConfig`. The **first chunk with `type:"snapshot"` resolves readiness** (`CR:rpc/session.ts:301-349,461-465`):
   ```ts
   ready: Deferred.await(connected).pipe(Effect.andThen(initialConfig), …)
   ```
   This times out after 15 s of establishment plus 75 s of synchronization (`CR:connection/supervisor.ts:52-54`).
3. `server.probe {}` must return `{}`. It is used on foreground, retry and network-change events (`session.ts:449-455`; supervisor `:782,836-850`).
4. The shell and thread subscriptions follow (§4.3).

---

## 4. RPC methods

`WsRpcGroup` (`C:rpc.ts:2105-2326`) has 220 RPCs: `WS_METHODS` (`C:rpc.ts:417-631`) plus `ORCHESTRATION_V2_WS_METHODS` (`C:orchestrationV2.ts:3772-3796`). The scope map is `S:auth/RpcAuthorization.ts:40-219`, plus `C:clientRpcPermissions.ts:19-107`.

As a rule of thumb, a method needing `orchestration:read`, `diagnostics:read`, `filesystem:read`, `terminal:read`, `access:read` or `relay:read` is a read. Anything else is an action. The explicit exceptions follow.

### 4.1 (a) Cacheable reads and subscriptions

U = unary, S = stream.

- **Required for readiness:**
  - `subscribeServerConfig` (S)
  - `server.probe` (U)
- **Config and lifecycle:**
  - `server.getConfig`
  - `subscribeServerLifecycle` (S)
  - `subscribeAuthAccess` (S)
  - `subscribeResourceTelemetry` (S)
  - `server.getHostResources`
  - `server.getTraceDiagnostics`, `getProcessDiagnostics`, `getProcessResourceHistory`, `getResourceTelemetryHistory`, `getUsageSummary`
  - `server.getStorageCleanupReport` (S), `server.getDatabaseStorage` (S)
  - `server.listAcpRegistryProviders`
  - `peerLinks.list`
  - `cloud.getRelayClientStatus`
- **Orchestration:**
  - `orchestration.subscribeShell` (S), `orchestration.subscribeThread` (S)
  - `orchestration.getTurnDiff`, `getFullThreadDiff`, `searchThreads`, `searchThread`
  - `orchestration.searchThreadStream` (S)
  - `orchestration.getArchivedShellSnapshot`, `getThreadFamily`, `getThreadTitles`, `getThreadLinkMetadata`, `getWorktreeThreadIds`, `getOlderSettledThreads`, `getThreadProjection`, `getWorkflowScript`, `getNativeChildWork`, `getTurnItem`
- **Scheduled tasks:**
  - `scheduledTasks.subscribe` (S; each item is the full list)
  - `scheduledTasks.listWebhookDeliveries`, `getWebhookDelivery` (reads, but need operate scope)
- **Projects, files, review:**
  - `projects.listEntries`, `listIgnoredFiles`, `readFile`, `searchContents`, `searchEntries`
  - `filesystem.browse`, `getMetadata`
  - `review.getBranchCommits`, `getDiffPreview`, `getDiffFileContents`
  - `mcpApps.toolInfo`
- **Pull requests and source control:**
  - `pullRequests.*` reads: `list`, `listStats`, `filterOptions`, `summary`, `routing`, `routingIdentity`, `stack`, `linkedThreads`, `detail`, `preview`, `checks`, `activity`, `reviewGuide`, `threadComments`, `diffFileContents`, `filesViewed`, `changeBreakdown`, `reviewerCandidates`, `labelCandidates`
  - `pullRequests.subscribeRefreshes` (S), `subscribeLinkedThreadRefreshes` (S)
  - `sourceControl.lookupRepository`, `appAccess`, `starred`
  - `subscribeProjectClones` (S)
- **VCS:**
  - `subscribeVcsStatus` (S), `subscribeVcsBranch` (S)
  - `vcs.listRefs`
  - `subscribeWorktreeSetup` (S)
- **Terminal, preview, device:**
  - `terminal.observe` (S), `subscribeTerminalMetadata` (S)
  - `preview.list`, `subscribePreviewEvents` (S), `subscribeDiscoveredLocalServers` (S)
  - `device.list`, `device.detail`, `subscribeDeviceState` (S)

**Live-computed or fire-and-forget calls.** Answer these locally while the host sleeps. Do not wake the host for them.
- **Heartbeat:**
  - `server.reportClientActivity` is the client's foreground heartbeat (`S:ws.ts:2694-2706`, `C:background.ts:67-80`).
  - Acknowledge it with `Exit Success`. If you forward it, the machine never idles.
  - Its `visible`, `focused` and `recentlyInteracted` fields tell the proxy whether the user is active.
- **Signals:** acknowledge these with `Exit Success`:
  - `pullRequests.invalidate`, `reportState`
  - `vcs.refreshBranch`
- **Probes:** serve these from cache, or fail them:
  - `server.refreshProviders` (not with `reloadSecrets: true`: that is the Refresh button), `server.discoverSourceControl`
  - `server.searchAcpRegistry` with an empty `query` (a typed search is a person asking)
  - `agentSessions.scan`
  - `vcs.refreshStatus` (its success is a `VcsStatusResult`, not void), `filesystem.getMetadata`
  - Not probes, although sent rarely: `server.listAcpRegistrySessions`, `git.resolvePullRequest` and `server.getNpmRelease` only follow a click, so they wake. `mcpApps.toolInfo` and `mcpApps.readResource` are sent as an MCP app shows and again on a click in it: serve the last answer, wake when there is none.
  - `provider.install.subscribe`
- **Asset URLs:** `assets.createUrl` mints a URL that the live host serves. Serve a cached `{url}` if you can serve the bytes too.
- **Live tails:** `orchestration.subscribePromptSuggestion` and `subscribePreviewEvents` carry no snapshot. Keep the stream open and send nothing. `orchestration.subscribeCommandOutput` is opened when a person expands a command row: a finished command answers with one final frame (`running: false`), which can be recorded and replayed; one never seen needs the machine.

### 4.2 (b) Actions that need the live machine (wake on these)

- **Orchestration:**
  - `orchestration.dispatchCommand`. The payload is `OrchestrationV2Command` (`C:orchestrationV2.ts:3052-3538`) and the result is `{sequence}`.
  - `orchestration.launchThread`, `stopWorkflow`, `forceStopThread`
- **Terminal:**
  - `terminal.open`
  - `terminal.attach` (S; may spawn a PTY)
  - `terminal.write`, `resize`, `clear`, `close`
  - `preview.stopLocalServer`
- **Files and projects:**
  - `projects.writeFile`, `mutate`, `ensureScratch`, `createNew`, `createFromThread`
  - `shell.openInEditor`
  - `assets.persistChatAttachments`
  - `attachments.createUploadUrl`, `delete`
- **Git and source control:**
  - `vcs.pull`, `createWorktree`, `removeWorktree`, `createRef`, `switchRef`, `init`
  - `git.runStackedAction` (S), `git.preparePullRequestThread`
  - `worktreeSetup.cancel`
  - `sourceControl.cloneRepository`, `publishRepository`, `star`, `signInStart`, `signInWait`, `signInCancel`
  - `projectClone.start`, `cancel`, `retry`
- **Pull requests:** `pullRequests.setFilesViewed`, `runAction`, `update`, `comment`, `updateComment`, `submitReview`, `replyToThread`, `setThreadResolution`, `setReaction`, `requestReviewers`, `setLabels`, `generateReviewGuide`
- **Providers:** `provider.*`, i.e. `auth.*`, `install.start`, `install.cancel`, `install.remove`, `chatgpt.*`, `consumeResetCredit`, `uploadFeedback`; plus `server.updateProvider`
- **Settings and server maintenance:**
  - `server.updateSettings`, `upsertKeybinding`, `removeKeybinding`
  - `server.runStorageCleanup`, `reclaimDatabaseSpace`
  - `server.updateServer`, `updateServerWithProgress`, `commitDesktopUpdate`
  - `server.signalProcess`, `prepareTriage`, `refreshUsageRates`, `retryResourceTelemetry`
  - `server.checkSecretSource`, `checkOtlpEndpoint`, `listTextGeneratorModels`
  - the ACP registry mutators
- **Scheduled tasks:** `scheduledTasks.upsert`, `setEnabled`, `delete`, `runNow`, `rotateWebhookToken`
- **Links, sharing, secrets:**
  - `peerLinks.link`, `unlink`, `answerRequest`
  - `guestShare.create`
  - `secrets.answerRequest`
  - `cloud.installRelayClient`
- **Preview and device:**
  - `preview.open`, `resize`, `adjust`, `close`, `clearProfile`, `reportProfiles`, `reportStatus`
  - `device.configure`, `testHost`, `easAccount`, `simlockIdentity`, `open`, `close`, `shutdown`, `action`
  - `device.list` with `retryHostId` or `updateTool` set (`RpcAuthorization.ts:303-306`)

**`dispatchCommand` `type` values** (all mutate; `C:orchestrationV2.ts:3052-3538`)
- **Starts or steers a turn:** `message.dispatch`, with `dispatchMode.type` one of `defer_start | steer_active | restart_active | queue_after_active | start_immediately`.
- **Thread lifecycle:** `thread.stop`, `create`, `archive`, `unarchive`, `delete`, `fork`, `merge_back`
- **Thread UI state:**
  - `thread.settle`, `auto-settle`, `unsettle`, `snooze`, `unsnooze`, `auto-settle.set`
  - `thread.pin`, `unpin`, `tag.set`, `pin.reorder`, `active.reorder`
  - `thread.visit`, `mark-unread`, `metadata.update`
  - `thread.guest-share.close`, `guest-message.dismiss`
- **Pull request links:** `thread.pull-request.link`, `unlink`, `pull-request-link.sync`, `pull-request.watch`, `pull-request.sync`
- **Titles and modes:**
  - `thread.title.regeneration.complete`
  - `thread.runtime-mode.set`, `interaction-mode.set`, `model-selection.set`
  - `provider-session.detach`, `provider.switch`
- **Runs:**
  - `prepared-run.release`, `progress`, `fail`, `retry`
  - `notification.delivery.accept`, `subagent.stop`, `run.interrupt`
- **Queue:** `queued-message.promote-to-steer`, `queue.resume`, `queued-run.start`, `reorder`, `cancel`, `edit`
- **Requests and checkpoints:** `runtime-request.respond`, `thread.user-input.dismiss`, `checkpoint.rollback`
- **Delegated tasks:** `delegated_task.request`, `wake-policy`, `completion-delivery.acknowledge`, `completion-delivery.dispose`
- **Records:** `thread.created.record`

Commands carry a `commandId`, which the server dedupes in `orchestration_v2_command_receipts` (`S:persistence/Migrations/055_OrchestrationV2.ts:40-49`). Holding an action until the host wakes and then forwarding it once is therefore safe.

**Optimistic local state:** `thread.visit`, `mark-unread`, `pin` and `snooze` are cheap UI writes. You may queue them and replay them after wake instead of waking for them.

### 4.3 Snapshots vs incremental updates (replay rules)

Server snapshots are sent as the stream's first item (`S:rpcInitialItems.ts:4-13`).

**`orchestration.subscribeShell`**
- Input (`C:orchestrationV2.ts:3886-3909`): `{afterSequence?, httpSnapshotFallback?, knownProjectIdentities?, requestCompletionMarker?, omitIdleSubagents?, omitOlderSettled?}`.
- Items (`:2349-2387`):
  ```json
  {"kind":"snapshot","snapshot":{"schemaVersion":1,"snapshotSequence":4812,"threads":[…],"archivedThreads":[…],"projects":[…],"olderSettled":{…}}}
  {"kind":"synchronized"}
  {"kind":"thread.updated","sequence":4813,"location":"active","thread":{…ThreadShell}}
  {"kind":"thread.removed","sequence":4814,"location":"active","threadId":"…"}
  {"kind":"project.updated","sequence":…,"project":{…}}   {"kind":"project.removed",…}   {"kind":"snapshot-required"}
  ```
- Server behaviour (`S:ws.ts:1333-1395`):
  - no cursor: full snapshot, then `synchronized`, then live updates
  - cursor it can replay: a projects-only snapshot with `resolvedRepositoryIdentityRoots`, then deltas, then `synchronized`
  - otherwise: a full snapshot, or `snapshot-required` alone when `httpSnapshotFallback` was set
- Client behaviour (`CR:state/shell.ts`):
  - It sends `afterSequence` only while its cache identity (`serverVersion`, `databaseMigration` and the omit flags) matches and the cache is under 12 h old (`:93,108-120,684-702`).
  - A snapshot **without** `resolvedRepositoryIdentityRoots` is authoritative and replaces the rows (`:373-389`).
  - It drops deltas with `sequence <= snapshotSequence` (`:324`).
  - It goes live only on `synchronized` (`:360-371`).
  - `snapshot-required` makes it reload over HTTP `/api/orchestration/shell` (`:394-399`).
- **Replay to a fresh subscriber:** send the recorded full `snapshot` item (without `resolvedRepositoryIdentityRoots`), then `{"kind":"synchronized"}`, and hold the stream open.
  - Key recordings by the `omit*` flags.
  - Keep the real `snapshotSequence`, so that after wake you can open upstream with `afterSequence` and forward deltas.

**`orchestration.subscribeThread`**
- Input (`:4007-4017`): `{threadId, afterSequence?, requestCompletionMarker?, acceptBoundedSnapshot?, acceptDeferredWork?, acceptCompactTurnItems?, acceptDedupedBodies?, acceptCompactIds?}`.
- Items (`:4118-4141`):
  ```json
  {"kind":"snapshot","snapshotSequence":…,"projection":{…},"historyCursor":…,"hasMoreHistory":…,"idTable":…}
  {"kind":"synchronized"}
  {"kind":"event","sequence":…,"event":{"type":"run.updated",…}}
  ```
- Server behaviour (`S:ws.ts:979-1124`): with `afterSequence`, it replays events and falls back to a snapshot.
- Client behaviour (`CR:state/threads.ts:528,645-676,1020-1107`): it accepts a snapshot at any time and resets `lastSequence` to it.
- **Replay:** send the recorded `snapshot`, then `synchronized`.
  - Key recordings by `threadId` plus the `accept*` flags, since they change the encoding.
  - **Do not replay recorded `event` tails.** Deduped and compact bodies reference earlier items of the same stream (`S:orchestration-v2/WireProjection.ts:388-405`). Instead, keep a live upstream subscription per recorded thread and fold its events into a fresh snapshot, or re-fetch the HTTP snapshot.

**`subscribeServerConfig`**
- Input flags (`C:rpc.ts:1986-2008`): `environmentThemes`, `usageLimitSources`, `usageLimitsCommand`, `workspaceSnapshotsOnDemand`, `providerCatalogsOnDemand`, `providerCatalogDigests`, `providerStatusDeltas`.
- Items (`C:server.ts:815-891`): `{version:1,type:"snapshot",config}`, then `keybindingsUpdated | providerStatuses | providerStatusDeltas | settingsUpdated | environmentThemesUpdated | usageLimitSourcesUpdated`.
- There is no cursor. Replay the latest snapshot, recorded under the same flags since the server gates event types by flag (`S:ws.ts:3371-3435`).
- Patch the snapshot: delete `directEndpoints` and set `serverTime` to now.

**Other subscriptions**
- These start with a snapshot and need no cursor:
  - `subscribeAuthAccess`: `{version:1,revision,type:"snapshot",payload:{pairingLinks,clientSessions,connectDevices}}` (`C:auth.ts:392-468`)
  - `subscribeServerLifecycle`: `{version:1,sequence,type:"welcome"|"ready"|…}`
  - `subscribeTerminalMetadata`: `{type:"snapshot",terminals:[TerminalSummary]}`, then `upsert` / `remove` (`C:terminal.ts:238-273`)
  - `terminal.observe`: `{type:"snapshot",snapshot:{status,history,…}}`
  - `subscribeVcsStatus`: `{snapshot…}`
  - `subscribeProjectClones` and `scheduledTasks.subscribe`: each item is the full list
- Replaying the latest first item is valid for all of them.

---

## 5. Client reaction to drop and reconnect

**Ownership:** one supervisor per environment (`CR:connection/supervisor.ts`; `docs/internals/connection-runtime.md`).

**Backoff**
- `retryDelayMs = jitter(min(300_000, 1000·2^(n+1)))`, using half the ceiling plus up to another half at random (`supervisor.ts:43-44,155-158`).
- The first loss of a live session retries after about 250 ms (`:45,1225-1232`).
- The ladder resets after a stable connection.

**Wakeups**
- Foregrounding, a network change or an explicit retry probes the session with `server.probe`, then a fresh descriptor GET (`connection-runtime.md` §1).
- Foregrounding also wakes a pending retry immediately.
- The supervisor re-checks earlier routes every minute (`supervisor.ts:759`).

**Blocked state**
- `ConnectionBlockedError` covers auth 401, scope errors, 404 on auth routes, id mismatch and unsupported protocol (`CR:connection/errors.ts:180-221`).
- The client waits for a wakeup and does not retry on a timer (`supervisor.ts:1185-1203`).

**State on reconnect**
- The registry keeps cached projections.
- Durable subscriptions re-subscribe on the new session with `afterSequence` (shell and thread), so state refetches automatically.
- Mutations are never replayed (`CR:rpc/client.ts`; `connection-runtime.md`, last paragraph).

**UI status**
- Phases are `available | offline | connecting | backoff | connected | blocked` (`CR:connection/model.ts:165-202`).
- Labels (`CR:connection/presentation.ts:55-106`):
  - "Offline"
  - "Connecting..."
  - "Reconnecting..." / "Failed to connect. Reconnecting... Reason: …"
  - "Connection failed. Reason: …" (blocked)
- Cached data stays visible while disconnected.
- **Implication:** if the proxy keeps the socket and config up while the host sleeps, the client shows "Connected" with cached data.
  - Surface the sleep state yourself, for example in the descriptor `label` or a settings toast. Note that changing `label` renames the environment in the UI.

---

## 6. Detecting a running turn from the stream

**Thread stream**
- Turn boundaries arrive as `{kind:"event", event:{type:"run.created"|"run.updated", payload: OrchestrationV2Run}}`, with `status`, `startedAt` and `completedAt` (`C:orchestrationV2.ts:724-765,1957-2106`).
- Run status values (`:638-649`):
  ```
  "preparing","queued","starting","running","waiting","completed","interrupted","failed","cancelled","rolled_back"
  ```
- Lower-level signals:
  - `run-attempt.*` (`:780-788`)
  - `provider-turn.updated` (`:1227-1234`)
  - `provider-session.*` with status `starting | ready | running | waiting | stopped | error` (`:988`)

**Shell rows** (`thread.updated.thread`, `OrchestrationV2ThreadShell`, `:2172-2254`)
- Busy indicators:
  - `status` is `"idle"` or a run status
  - `activeRunId` is not null
  - `activityRunStatus` is one of `"preparing"|"starting"|"running"|"waiting"`
  - `pendingRuntimeRequest` is not null; its `kind` is approval or user-input and `blocking?` is set
  - `pendingBackgroundTasks` is non-empty
  - `blockedOnThreadWait`
- Timestamps:
  - `latestRunRequestedAt`, `latestRunStartedAt`, `latestRunCompletedAt`
  - `updatedAt`

**Predicate the codebase already uses** (`isLiveSubagentShell`, `:2257-2282`)
```
activityRunStatus != null || status ∈ {queued,preparing,starting,running,waiting}
  || pendingRuntimeRequest != null || pendingBackgroundTasks.length > 0
```

**Caveat:** idle-compaction runs are hidden from shell rows (`S:orchestration-v2/ProjectionStore.ts:1697-1699`). Use §9 for authoritative server-side idleness.

---

## 7. Server-side setup and authentication strategy

**Binding**
- `t3 serve --lan` (or `T3CODE_LAN=1`) binds `0.0.0.0` but only accepts peers whose addresses are loopback, private or tailnet IPv4 (`S:cli/config.ts:428-443`, `S:server.ts:365-371`).
- `--host 0.0.0.0` makes the server fully reachable.
- The auth policy is then `remote-reachable` with bootstrap method `one-time-token` (`S:auth/EnvironmentAuthPolicy.ts:22-40`).
- The default port is 3773 (`S:config.ts:29`).
- `linkedEnvironmentsEnabled` (`C:settings.ts:1477`) only gates peer links. It is not needed.

**CLI** (`S:cli/auth.ts`)
- The CLI opens the same `~/.t3/userdata/statev2.sqlite` and secrets in-process through `EnvironmentAuth.layerRuntime`. It needs no running server or network auth: filesystem access is the credential.
- **`t3 auth pairing create [--scope …]… [--ttl 5m] [--label] [--base-url URL] [--json]`** (`:91-122`)
  - creates a one-time pairing token; the default TTL is 5 min (`S:auth/PairingGrantStore.ts:326`)
  - `--json` prints the credential, its expiry and a `/pair#token=` URL when `--base-url` is given
- **`t3 pair [--scope] [--ttl] [--tailscale]`** does the same against the running server's base URL and prints a QR code (`S:cli/pair.ts:512-603`).
- **`t3 auth session issue [--scope …]… [--ttl 3650d] [--label] [--subject] [--token-only|--json]`** (`:246-279`)
  - mints a long-lived **bearer session** (`method: bearer-access-token`)
  - default scopes are `AuthStandardClientScopes` (`C:auth.ts:150-…`)
  - default TTL is 30 d (`S:auth/SessionStore.ts:448`)
  - `--json` prints `{sessionId, token, method, scopes, subject, client, expiresAt}`
- **`t3 auth session list --json`** and **`t3 auth session revoke <id>`**.

**Recommended design**
- **Upstream:** the proxy holds one token from `ssh host t3 auth session issue --token-only --ttl 3650d --label t3boat-proxy`.
  - It uses `Authorization: Bearer <tok>` on HTTP requests and on the `/ws` upgrade, so it needs no tickets.
  - Alternatively it can call `POST /api/auth/websocket-ticket/rpc` and use `?wsTicket=`.
  - Always add `orchestrationProtocol=2`, and `frameParts=1` if you want parts.
  - Pass the desktop's `client*` query parameters through, or set your own.
- **Downstream:** the proxy is its own auth server.
  - Generate a pairing code and open `t3code://pair?pairingUrl=http%3A%2F%2Flocalhost%3APORT%2Fpair%23token%3DCODE`.
  - Implement `POST /oauth/token`: accept that code once and return `{access_token:<random>, issued_token_type, token_type:"Bearer", expires_in, scope:<upstream scopes>}`.
  - Implement `POST /api/auth/websocket-ticket/rpc`: return `{ticket:<random>, expiresAt}`.
  - Implement `GET /api/auth/session`.
  - Validate the bearer token or ticket on every request.
  - The client never inspects token format.

**Pure pass-through of the desktop's credential is possible but worse**
- Forward `/oauth/token` upstream so the desktop gets a real 30-day upstream token; the proxy captures it.
- While the host sleeps, the proxy must still fake tickets and accept the socket.
- Upstream it then has to use the captured bearer token anyway, because tickets it faked are not valid upstream.
- Pairing also needs a live host plus a one-time code minted on the host.
- The token expires in 30 days with no refresh, so the desktop must re-pair.
- With its own downstream auth, the proxy controls expiry and works without the host.

---

## 8. Host identity pinning

**What the client pins**
- `environmentId` (descriptor plus `config.environment`), checked on every connect (§0.2).
- `orchestrationProtocolVersion === 2` (`C:environment.ts:13-16`; HTTP 426 otherwise).

**What it does not pin**
- No TLS pinning and no server signature.
- Changing the upstream URL behind the proxy is invisible to the desktop, as long as the environment id stays the same. Ids persist across restarts in `~/.t3/userdata/environment-id` (`S:config.ts:171`).

**URLs the server embeds**
- `directEndpoints` in `ServerConfig` (`C:server.ts:662-695`) are LAN and tailnet base URLs that the client saves as learned routes. **Strip them.**
- Asset and upload URLs are relative (`/api/assets/…`, `/api/attachments/upload/…`) and resolve against the proxy's base URL.
- MCP OAuth metadata derives URLs from `Host` and `X-Forwarded-Proto` (`docs/internals/environment-auth.md:68-71`); the desktop UI does not use it.
- `t3 pair` and startup pairing URLs use the server's own origin. The proxy mints its own pairing URL instead.

**Shell cache identity:** if the upstream `serverVersion` or `databaseMigration` changes, the client discards its shell cursor (`CR:state/shell.ts:108-120`). Invalidate proxy recordings on the same keys.

---

## 9. Idle watchdog on the server machine

### Local authentication

- Local processes need no network login. Any process running as the T3 user can run `t3 auth session issue --token-only --scope orchestration:read --scope access:read --scope terminal:read --ttl 3650d --label watchdog` once, and keep the token.
- The CLI writes straight into `statev2.sqlite` (§7).
- `t3 thread …` mints a short-lived **MCP** session per call and talks to `/mcp`:
  - It finds the server through `~/.t3/userdata/server-runtime.json`, schema `{version:1,pid,port,origin,host?,privateNetworkOnly?,startedAt,serviceManaged?,serverVersion?}` (`S:serverRuntimeState.ts:12-35`; `S:cli/thread.ts:215-251`).
  - It is too heavy to poll.
- Read `origin` from `server-runtime.json` for the URL; the default is `http://127.0.0.1:3773`.

### (a) Is anything running? (cheapest first)

1. **The server's own keep-awake inhibitor** (`S:background/KeepAwake.ts:17-150`).
   - The server holds an inhibitor while any run has status `preparing | starting | running`, plus 60 s of grace:
     ```sql
     SELECT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running'))
     ```
   - The inhibitor process:
     - Linux: `systemd-inhibit --what=idle:sleep --who="T3 Code" --why="Agents are working" … tail --pid=<serverpid> -f /dev/null`
     - macOS: `caffeinate -i -w <pid>`
   - Watchdog checks: `systemd-inhibit --list --no-legend | grep -q 'T3 Code'` on Linux, or `pgrep -f "caffeinate -i -w $PID"` on macOS.
   - It requires `keepAwakeWhileAgentsWork` (default `true`, `C:settings.ts:1385`) and logind.
   - **It excludes `queued` and `waiting`**, so a run blocked on an approval or user-input prompt does **not** hold it.
2. **The same query, run directly:** `sqlite3 -readonly ~/.t3/userdata/statev2.sqlite "<query above>"`.
   - The database is in WAL mode, so a read-only connection works while the server runs.
   - This is internal schema (`S:persistence/Migrations/055_OrchestrationV2.ts:73-87`). Pin it to the version.
   - Add `'queued','waiting'` to the status list to count pending approvals as busy.
3. **The supported API: shell snapshot over HTTP**
   ```sh
   curl -s -H "authorization: Bearer $TOK" -H "x-t3-orchestration-protocol: 2" "$ORIGIN/api/orchestration/shell" \
   | jq '[.threads[] | select(.activeRunId!=null or .activityRunStatus!=null
          or (.status|IN("queued","preparing","starting","running","waiting"))
          or .pendingRuntimeRequest!=null or ((.pendingBackgroundTasks//[])|length>0))] | length'
   ```
   - The fields are the ones listed in §6.
   - Decide yourself whether a `pendingRuntimeRequest` with `blocking:true` counts as busy. The server's keep-awake says no; the client UI shows it as needing attention.

### (b) Last orchestration activity

- Shell: `max(.threads[].updatedAt, .latestRunCompletedAt, .latestRunStartedAt)`.
- SQLite: `SELECT MAX(occurred_at) FROM orchestration_events` (`S:persistence/Migrations/001_OrchestrationEvents.ts:8-22`; the current store reads `orchestration_events`, `S:persistence/OrchestrationEventStore.ts:669-673`).
- The high-water mark is `MAX(sequence)` from the same table.

### (c) Connected WebSocket clients

- The `connected` flag is **in-memory** in the server process: `connectedSessionsRef` (`S:auth/SessionStore.ts:521-660`).
  - `t3 auth session list --json` runs in its own process, so `connected` is always `false` there.
  - Only `lastConnectedAt` is persisted, and it is updated on connect.
- **The reliable source is RPC `subscribeAuthAccess`** (scope `access:read`). Its first chunk has `payload.clientSessions[]`, each `{sessionId, subject, client, connected, lastConnectedAt, issuedAt, expiresAt}`.
  - Exclude the proxy's own and the watchdog's own `sessionId`.
- **"Last request time" is not exposed.** `BackgroundPolicy` leases (`S:background/BackgroundPolicy.ts:42-118`) track `server.reportClientActivity` heartbeats, but nothing serves them.
  - The proxy is the right place to track user activity. It sees every request and the `visible`, `focused` and `recentlyInteracted` heartbeat fields.
  - If the proxy keeps its upstream socket open while the desktop is gone, the watchdog sees the proxy as "connected". So the proxy should close its upstream socket when no desktop client is attached, or the watchdog should ignore the proxy's session.

### (d) Active terminals

- RPC `subscribeTerminalMetadata` (scope `terminal:read`). The first chunk is `{type:"snapshot",terminals:[{threadId,terminalId,status:"starting"|"running"|"exited"|"error",pid,hasRunningSubprocess,updatedAt,…}]}` (`C:terminal.ts:216-273`).
- Busy means `status=="running" && hasRunningSubprocess`. An idle shell prompt has `hasRunningSubprocess:false`.

### Minimal one-shot WebSocket client

Node `ws`, as used for (c) and (d):
```
GET ws://127.0.0.1:3773/ws?orchestrationProtocol=2      Authorization: Bearer $TOK
→ {"_tag":"Request","id":1,"tag":"subscribeAuthAccess","payload":{},"headers":[]}
→ {"_tag":"Request","id":2,"tag":"subscribeTerminalMetadata","payload":{},"headers":[]}
← {"_tag":"Chunk","requestId":1,"values":[{"version":1,"revision":…,"type":"snapshot","payload":{…}}]}
← {"_tag":"Chunk","requestId":2,"values":[{"type":"snapshot","terminals":[…]}]}
→ {"_tag":"Interrupt","requestId":1,"interruptors":[]}  (or just close the socket)
```
Without `frameParts=1`, frames arrive whole. Ignore `Pong`. Use `--scope orchestration:read` for `orchestration.subscribeShell` if you prefer it to the HTTP route.

---

## 10. Linked environments (peer links)

One T3 server (the linker) links to another (the target) so its agents can work there. One-way: the target never calls back. Source: `S:peer/PeerLinks.ts`, `S:peer/PeerMcpClient.ts`, `S:auth/McpOAuth.ts`, `S:cli/environment.ts`.

**Linking** (`t3 environment link <url> --pairing-code <code> --access <level>`, or `peerLinks.link`)
- The CLI opens the linker's database and secret store itself, so it works whether or not the desktop app runs. `linkedEnvironmentsEnabled` must be on at both ends (default off; Settings → Labs).
- Plain `http:` is allowed for loopback, so `http://localhost:PORT` links. Redirects are not followed.
- Requests to the target, in order:
  1. `GET /.well-known/t3/environment`: must carry `capabilities.mcpModeLimitHeader` and `linkFence`.
  2. `POST /oauth/mcp/register` (JSON) → `{client_id}`.
  3. `POST /oauth/mcp/decision` (JSON `{authorization: {…, resource}, decision: {_tag: "pairing-code", access, code}}`) → `{redirectTo}`.
  4. `POST /oauth/mcp/token` (form, with `resource`) → `{access_token, expires_in, …}`.
- `resource` is `<the URL the linker knows>/mcp`, and the target only issues tokens for `<its own origin>/mcp`, which it derives from `Host` and `x-forwarded-proto`. Behind the proxy the two differ: rewrite `resource` in steps 3 and 4.
- A pairing code with the scopes for an access level comes from `POST /api/auth/pairing-token` `{label, scopes}` with a session that holds `access:write` → `{credential}`. Full access needs `orchestration:read`, `orchestration:operate`, `settings:write`, `source-control:write`.
- The token lasts 30 days and cannot be refreshed; linking again replaces it.

**After linking**
- Status (`peerLinks.list`, `t3 environment list --json`): only `GET /.well-known/t3/environment`, 3 s on loopback. Answer it from cache.
- Every tool call probes the descriptor the same way, then speaks streamable-HTTP MCP at `POST /mcp` with `Authorization: Bearer`.
  - `initialize` and `notifications/initialized` together get the probe timeout: **3 s on loopback**. The session id is cached in memory per linker.
  - `tools/call` has no timeout. A 404 makes the linker open a new session once and retry: how it survives a restart of the target.
  - A 401 means "link revoked": it fails the call with `capability_denied`, which ends a delegated task's follower for good. Never answer 401 for a sleeping machine.
- `delegate_task` follows its remote thread with `t3_thread_wait` in chunks of at most 50 s until the task ends.
