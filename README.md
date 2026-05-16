# Voxal MCP Server 🎙️

Voxal is an MCP (Model Context Protocol) server that enables your AI models to autonomously place phone calls using Twilio Media Streams and the Gemini Multimodal Live API.

## Features

- Exposes `execute_phone_call` MCP tool.
- Supports DTMF tone generation, allowing the AI to navigate IVR menus natively.
- Full two-way streaming using websockets between Twilio and Gemini 3.1 Flash Live.
- Built-in websocket tunneling using ngrok SDK (no port-forwarding or public IP required).
- Persistent user context and ephemeral context provided by agents.

## Setup & Configuration

1. Create a Twilio account with a paid subscription and purchase a phone number.

2. Create a free Ngrok account.

3. Clone this repository.

4. Create a `.env` file in the root directory, and fill in the required environment variables:

```env
# Twilio account information
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# Generative AI settings
GEMINI_API_KEY=your_gemini_api_key

# Ngrok account for tunneling
NGROK_AUTHTOKEN=your_ngrok_authtoken
```

5. Install dependencies and build:
```bash
npm install
npm run build
```

6. Run the server:
```bash
npm start
```

## Using with MCP

The server supports stdio and SSE transports. You can configure it in Claude Desktop or your preferred MCP client:

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

## How It Works

When an AI calls `execute_phone_call`:

1. The server requests a secure public Ngrok endpoint (`https://<ngrok>.ngrok-free.app`).
2. Twilio is instructed to connect a call and point its Media Stream (WebSocket) to the Ngrok endpoint.
3. When the user picks up, the MCP server opens a WebSocket connection to Gemini 3.1 Flash Live.
4. The server translates Twilio's incoming 8kHz µ-law audio into 16kHz PCM16, streaming it to Gemini.
5. The server receives Gemini's PCM16 audio, converts it back to µ-law, and streams it back to the phone.
6. Gemini uses the `task_completed` function when done, returning the summary to the MCP caller!
