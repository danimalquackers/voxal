import 'dotenv/config';
import express from 'express';
import expressWs from 'express-ws';
import ngrok from '@ngrok/ngrok';
import { hostHeaderValidation } from "@modelcontextprotocol/express"
import { config } from './config.js';
import { serverState } from './services.js';
import { handleTwilioWebSocket } from './twilio-ws-handler.js';
import { handleMcpRequest, initStdioMcp } from './mcp-handler.js';

async function startServer() {
    console.log(`[Ngrok] Initializing tunnel...`);
    
    const port = config.port;

    // Start ngrok tunnel
    let publicUrl: string = `http://${config.host}:${config.port}`;
    try {
        const listener = await ngrok.forward({
            addr: port,
            authtoken: config.ngrok.authtoken,
            domain: config.ngrok.domain,
        });

        // Extract the URL to display in logs
        publicUrl = listener.url() || publicUrl;
        serverState.publicUrl = publicUrl;

        console.log(`[Ngrok] Tunnel established at: ${publicUrl}`);
    } catch (err) {
        console.error('[Ngrok] Failed to establish tunnel:', err);
    }

    // Create an Express app with websocket support
    const appBase = express();
    const { app } = expressWs(appBase);

    // Parse StreamableHTTP requests
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Log connection endpoints
    if (publicUrl) {
        console.error(`[Twilio] Twilio Media Stream URL: ${publicUrl}/media-stream`);
        console.log(`[MCP] StreamableHTTP URL: ${publicUrl}/mcp`);
    }
    
    // WebSocket endpoint for Twilio Media Stream
    app.ws('/media-stream', handleTwilioWebSocket);

    // MCP StreamableHTTP endpoint (with DNS rebinding protection)
    app.all(
        '/mcp',
        hostHeaderValidation(['localhost', '127.0.0.1', '[::1]', config.host]),
        handleMcpRequest
    );

    // Stdio initialization for CLI testing
    await initStdioMcp();

    app.listen(config.port, config.host, () => {
        console.log(`[Express] Server listening on ${config.host}:${config.port}`);
    });
}

startServer().catch(console.error);
