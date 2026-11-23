# Voice Memory Lab

Can a call use a correction that arrives after the session opens? The default case changes a preferred airport from Oakland to San Jose while the call stays open. Use saved replay for repeatable checks or live mode to write and retrieve the change from Supermemory.

The call-start policy answers current-state questions using its opening profile. The per-turn policy checks the latest readable profile. For questions about the past, both policies use historical search results from the selected mode. A lookup that misses its 1.2-second budget asks the caller to confirm. Starting a new turn, receiving a correction, or hanging up invalidates an in-flight lookup. A late result cannot enqueue a second answer.

## Run locally

From the repository root:

```sh
node --experimental-strip-types experiments/voice/server.ts
```

Open [http://127.0.0.1:4179](http://127.0.0.1:4179). Start the call, ask for the current value, send the correction, then ask again. Try the previous-value question, the forced slow lookup, and interrupting a lookup before it returns. Listen to either answer with **Play answer**. The per-turn lane also attempts playback automatically. Use **Download JSON** to inspect the event timeline.

The default capture and fact are bundled. Use `--capture runs/pilot --fact shipping` to replay the local shipping-city pilot if you have that capture. Saved replay needs no API credentials or billable calls.

## Run against Supermemory

With `SUPERMEMORY_API_KEY` in the project’s local `.env` file:

```sh
node --env-file=.env --experimental-strip-types experiments/voice/server.ts --live --port 4180
```

Open [http://127.0.0.1:4180](http://127.0.0.1:4180). Starting a call seeds a fresh namespace and waits up to 60 seconds, plus the final request, for the old profile to become readable. **Send correction** writes the new fact once in the same namespace. Ask again immediately to see what happens before indexing finishes, then retry when you want another observation.

The per-turn policy asks for confirmation if the updated profile lacks an unambiguous new value, if retrieval fails, or if the turn exceeds its 1.2-second budget. The call-start profile remains visible as the comparison. The historical question uses hybrid search. A superseded turn aborts its browser request, and the local service carries that cancellation through to the API.

Each live call can use up to two instant writes and 32 reads, including its opening probes. All data written by this demo is synthetic. Ending the call releases its local session state. The documents remain in their dedicated Supermemory namespace.

## Ask by microphone

Use **Ask by voice** in a browser that supports on-device Web Speech recognition and has its English language pack installed. Say “What is my current airport?” or “What was my previous airport?” The demo uses a restricted set of question types and local speech synthesis. If on-device recognition is unavailable, use the same question buttons. There is no hosted speech-recognition fallback. [On-device Web Speech support](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally)

```sh
node --experimental-strip-types --test experiments/voice/voice.test.ts
```

## What it measures

The interface records time to answer ready and, when a local browser voice is available, the browser’s playback-start event. Saved mode replays retrieval delay from the archive. Live mode measures the current API request. The forced timeout is simulated in either mode. Replies are deterministic selections from the returned evidence. The playback start marker is a browser event rather than a telephony or hardware measurement.

Supermemory’s [Pipecat release PR](https://github.com/supermemoryai/supermemory/pull/1915) documents the difference between a call-start profile and per-turn context in native speech-to-speech integrations. This demo exercises the application-level policy in a browser session. It uses neither a hosted realtime model nor a telephony provider.
