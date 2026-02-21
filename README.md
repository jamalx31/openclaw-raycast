# openclaw-raycast

Raycast extension for chatting with an OpenClaw agent.

## Features
- **Chat with OpenClaw** (typed chat)
  - REST mode (`POST /query`)
  - WebSocket mode (streaming deltas + final)
  - Gateway `connect.challenge` handshake with Ed25519 device identity
  - Persistent in-command WebSocket connection
  - Connection status badges: connecting / pairing / connected / error
- **Talk to OpenClaw** (voice chat)
  - Live streaming transcription using Apple Speech framework (no API keys, works offline)
  - Silence-based auto-stop — listens until you pause, then sends
  - Text-to-speech replies using Jamie Premium voice
  - Interruptible TTS — starting a new recording or closing Raycast stops speech
  - Conversation history persisted across sessions (last 40 messages)
  - Sends to configurable OpenClaw channel endpoint (`POST /api/channels/{channelName}/message`)
- Optional bearer token auth
- Optional fixed `sessionId`

## Swift CLI Tools
The `tools/` directory contains Swift source for native macOS helpers:

| Tool | Purpose |
|------|---------|
| `listen.swift` | Live mic recording + streaming transcription (SFSpeechRecognizer) |
| `speak.swift` | Text-to-speech with Jamie Premium voice (AVSpeechSynthesizer) |
| `record.swift` | Standalone mic recording to .wav (AVAudioRecorder) |
| `transcribe.swift` | File-based transcription (SFSpeechURLRecognitionRequest) |

Compiled automatically by `npm run build-tools` into `assets/`.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build Swift tools + extension:
   ```bash
   npm run build
   ```
3. In Raycast extension preferences, set:
   - `API Base URL` — your OpenClaw gateway (e.g. `http://127.0.0.1:18789`)
   - `API Bearer Token` (optional)
   - `Session ID` (optional, defaults to `agent:main:main`)
   - `Channel Name` (optional, defaults to `openclaw-raycast`)
   - `Record Seconds` (optional, max listen time — silence detection handles actual stopping)
   - For WebSocket mode:
     - `Transport Mode`: `WebSocket`
     - `Gateway WebSocket URL`
     - `Gateway RPC Method` (default `chat.send`)
     - `Enable Debug Logs`
4. Run in dev mode:
   ```bash
   npm run dev
   ```
5. On first use, grant macOS permissions for Microphone and Speech Recognition.
6. In Raycast, assign a global hotkey to `Talk to OpenClaw`.

## API contract
### Talk to OpenClaw (channel endpoint)
`POST {BASE_URL}/api/channels/{channelName}/message`

Request:
```json
{ "sessionId": "agent:main:main", "clientId": "hostname", "message": "hello" }
```

Response:
```json
{ "ok": true, "reply": "...", "text": "...", "read": "..." }
```
- `text` — full written answer
- `read` — short spoken summary (used for TTS)
- `reply` — fallback plain text

### Chat with OpenClaw (REST mode)
`POST {BASE_URL}/query`

Request: `{ "message": "hello", "sessionId": "optional" }`
Response: `{ "reply": "..." }` or `{ "message": "..." }` or `{ "text": "..." }`

### Chat with OpenClaw (WebSocket mode)
Client sends:
```json
{ "type": "req", "id": "...", "method": "chat.send", "params": { "message": "hello" } }
```

Server streams:
- `{"type":"event","event":"chat","payload":{"state":"delta","message":...}}`
- `{"type":"event","event":"chat","payload":{"state":"final","message":...}}`

## Testing
```bash
npm install
npm run build-tools   # compile Swift CLIs
npx tsc --noEmit      # type check
npm run dev           # run in Raycast
```

### Manual test matrix
1. **Voice flow** — Run Talk to OpenClaw, speak, verify live transcript + reply + TTS
2. **Silence detection** — Pause mid-speech, verify it waits; stop talking, verify it sends after ~2s
3. **TTS interruption** — While OpenClaw is speaking, hit Record and Send or close Raycast
4. **History persistence** — Close Raycast, reopen Talk to OpenClaw, verify history loads
5. **REST chat** — Set Transport=REST, send prompt, verify reply
6. **WebSocket chat** — Set Transport=WebSocket, verify streaming + connection status
7. **Gateway handshake** — Verify `connect.challenge` auth completes

### Debugging
- Enable `Enable Debug Logs` in preferences
- Check Raycast console for `[listen]`, `[speak]`, `[voice]`, `[openclaw-raycast][gateway]` logs

## Next up
- [ ] Gateway-synced chat history (fetch from server instead of local storage)
- [ ] WebSocket transport for Talk to OpenClaw (streaming replies)
- [ ] Push-to-talk (hold-to-record instead of timed recording)
- [ ] Session picker from gateway `sessions.list` RPC
