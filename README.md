# Voxal MCP Server 🎙️

> **Legal Notice:** This application uses AI to autonomously initiate and participate in phone calls. By using this software, you acknowledge that you are responsible for any calls made, and you agree to ensure compliance with all applicable laws and regulations, including those related to automated calling, recording, and telecommunications. Always ensure that you have the necessary consent before placing or recording any call.

Voxal is an MCP (Model Context Protocol) server that enables your AI models to autonomously place phone calls using Twilio Media Streams and the Gemini Multimodal Live API.

## Features

- Exposes `execute_phone_call` MCP tool.
- Supports DTMF tone generation, allowing the AI to navigate IVR menus natively.
- Full two-way streaming using websockets between Twilio and Gemini 3.1 Flash Live.
- Built-in websocket tunneling using ngrok SDK (no port-forwarding or public IP required).
- Persistent user context and ephemeral context provided by agents.
- Inline call transcription with timestamped speaker labels (enabled by default).

## Setup & Configuration

1. Create a [Twilio](https://www.twilio.com/try-twilio) account [**with a paid subscription**](https://help.twilio.com/articles/223183208-Upgrading-to-a-paid-Twilio-Account) and [purchase a phone number](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console).

2. Create a free [Ngrok](https://dashboard.ngrok.com/signup) account.

3. Create a free [Gemini API key](https://aistudio.google.com/app/apikey)

4. Clone this repository.

5. Create a `.env` file in the root directory, and fill in the required environment variables (all environment variables also support the `VOXAL_` prefix):

```env
# Required: Twilio account information
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# Required: Generative AI settings
GEMINI_API_KEY=your_gemini_api_key

# Required: Ngrok account for tunneling
NGROK_AUTHTOKEN=your_ngrok_authtoken

# Optional: Ngrok custom domain
# NGROK_DOMAIN=your-custom-domain.ngrok-free.app

# Optional: Server settings (defaults shown)
# HOST=127.0.0.1
# PORT=3000

# Optional: Gemini model and voice (defaults shown)
# VOXAL_GEMINI_MODEL=gemini-3.1-flash-live-preview
# VOXAL_GEMINI_VOICE=Fenrir

# Optional: File paths (defaults shown)
# VOXAL_CONTEXT_FILE=./user_context.txt
# VOXAL_RECORDINGS_DIR=./recordings

# Optional: Feature flags
# VOXAL_TRANSCRIPTION=true          # Set to "false" to disable call transcripts
# VOXAL_CALL_TIMEOUT=600            # Call timeout in seconds (default: 10 minutes)
# VOXAL_AGENT_PROMPT=...            # Additional agent instructions (default: "")
```

6. Install dependencies and build:
```bash
npm install
npm run build
```

7. Run the server:
```bash
npm start
```

All options can also be passed as CLI flags (run `npm start -- --help` to see the full list).

## Using with MCP

The server supports stdio and Streamable HTTP transports. You can configure it in Claude Desktop or your preferred MCP client:

### Stdio Transport

```json
{
  "mcpServers": {
    "voxal": {
      "command": "node",
      "args": [ "/path/to/voxal-mcp/dist/index.js" ],
      "env": {
        "ENABLE_STDIO": "true",
        "TWILIO_ACCOUNT_SID": "...",
        "TWILIO_AUTH_TOKEN": "...",
        "TWILIO_PHONE_NUMBER": "...",
        "GEMINI_API_KEY": "...",
        "NGROK_AUTHTOKEN": "..."
      }
    }
  }
}
```

### Streamable HTTP Transport

If the server is already running, you can connect via HTTP:

```json
{
  "mcpServers": {
    "voxal": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## How It Works

When an AI calls `execute_phone_call`:

1. The server requests a secure public Ngrok endpoint (`https://<ngrok>.ngrok-free.app`).
2. Twilio is instructed to connect a call and point its Media Stream (WebSocket) to the Ngrok endpoint.
3. When the user picks up, the MCP server opens a WebSocket connection to Gemini 3.1 Flash Live.
4. Twilio streams incoming audio as **8kHz 8-bit G.711 µ-law**. The server decodes and resamples it to **16kHz 16-bit PCM** for Gemini.
5. Gemini generates response audio as **24kHz 16-bit PCM**. The server downsamples and re-encodes it to **8kHz µ-law** for Twilio.
6. If transcription is enabled, Gemini's native `inputAudioTranscription` and `outputAudioTranscription` provide real-time text for both sides of the conversation.
7. Gemini uses the `task_completed` function when done, returning the summary to the MCP caller!

## User Context

Voxal supports a persistent `user_context.txt` file in the root of the project (or specified via `--context-file` / `VOXAL_CONTEXT_FILE`). This context acts as a "cheat sheet" for the AI voice assistant when placing calls on your behalf, helping it answer basic verification questions and guide decisions.

### Information to Include

- **Verification Essentials:**
  - Legal name and preferred name (e.g., "My legal name is Johnathan Aloysius Doe, but I go by John").
  - Date of Birth (common for verifying doctor appointments, telecom bills, or utility accounts).
  - Billing / Service Address (needed for dispatching home services like plumbers, matching account details, or finding nearest locations).
- **Callback & Contact Details:**
  - Your actual mobile/home phone number (since the call will originate from the Twilio number, provide your personal phone for callbacks or lookups).
  - Primary email address (for booking confirmations, tickets, or invoice receipts).
- **Account Identifiers (Non-Sensitive):**
  - Insurance company, employer, and group/member IDs for health/dental insurance (crucial for medical appointments).
  - Frequent flyer or hotel rewards program membership numbers.
  - Non-sensitive account numbers (e.g., gym membership ID).
- **Preferences & Boundaries:**
  - Standard availability windows (e.g., "Only schedule appointments on Tuesdays and Thursdays after 1:00 PM").
  - Service constraints (e.g., "Only book mechanics in downtown San Francisco", "Always request a synthetic oil change").

### ⚠️ Information to STRICTLY Exclude

To safeguard your privacy and security, **never** include sensitive credentials in the context file. The AI will provide any information requested from the context, and the context file is not protected.

1. **Passwords, PINs, or Security Code/Tokens:** Do not provide the AI with passwords or anything that it could inadvertently disclose.
2. **Social Security Number (SSN):** Never write your SSN or national tax ID.
3. **Financial details:** Avoid writing Credit Card Numbers, CVVs, or bank account routing numbers. Instead, have the agent ask the representative: *"Can you text a payment link, or email a digital invoice?"*

---

## Recordings

You can optionally save the recording of each call by setting the `record_call` parameter to `true` when invoking the MCP tool. 

The recording files are saved as raw, headerless PCM16 (1 channel) streams:
- `call_<SID>_received.raw`: The incoming user audio stream received from Twilio, decoded from 8kHz µ-law and upsampled to **16kHz 16-bit PCM**.
- `call_<SID>_sent.raw`: The outgoing agent audio stream generated by Gemini at **24kHz 16-bit PCM** (silence is inserted during pauses to maintain time alignment).

### Playing Back Raw Recordings

Since the files are headerless `.raw` PCM streams, media players won't be able to auto-detect their configuration. You can play them back using `ffplay` (part of the `ffmpeg` package):

* Twilio (human) recordings: `ffplay -f s16le -ac 1 -ar 16000 -i recordings/call_<SID>_received.raw`
* Gemini recordings: `ffplay -f s16le -ac 1 -ar 24000 -i recordings/call_<SID>_sent.raw`
* Combined: Use the helper script in this repository - `./play.sh <SID>`

A future version may improve this process by re-encoding the audio.

## Transcription

Call transcription is **enabled by default**. Transcripts are saved to the recordings directory as `call_<SID>_transcript.txt` and are also exposed as MCP resources (`transcript://<SID>`).

To disable transcription, set `VOXAL_TRANSCRIPTION=false` in your environment or pass `--no-transcription` on the CLI.

Transcript files include a metadata header and timestamped, speaker-labeled entries:

```
Call Transcript
Date: 5/16/2026, 8:30:00 PM
Objective: Ask if they have swimming pool in stock
──────────────────────────────────

[00:03] Agent: Hi, I'm calling on behalf of my client...
[00:08] User: Sure, let me check on that for you.
[00:15] User: Yes, we have that in stock.
[00:18] Agent: Great, thank you so much!
```

---

> **AI Disclosure:** Development of this project was heavily augmented by AI tooling, including Antigravity IDE and Gemini CLI.
