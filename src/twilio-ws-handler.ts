import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { GeminiBridge } from './gemini-bridge.js';
import { decodeMulawToPcm16, encodePcm16ToMulaw, generateDtmfPcm16 } from './audio-utils.js';
import { activeCalls, cleanupCall } from './call-registry.js';

const recordingsDir = config.recordingsDir;
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
}

export function handleTwilioWebSocket(ws: any, req: any) {
    console.log('[Express] Twilio Media Stream WebSocket connection opened.');

    let callSid: string | null = null;
    let streamSid: string | null = null;
    let bridge: GeminiBridge | null = null;

    ws.on('message', async (message: string) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case 'connected':
                console.log(`[Twilio WS] Media Stream connected.`);
                break;
            case 'start':
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                console.log(`[Twilio WS] Stream started for call ${callSid}`);
                
                const callContext = activeCalls.get(callSid!);
                if (callContext) {
                    bridge = new GeminiBridge({
                        apiKey: config.apiKey,
                        model: config.model,
                        voice: config.voice,
                        objective: callContext.objective,
                        context: callContext.context,
                        recordCall: callContext.recordCall
                    });
                    
                    // Store reference for later cleanup
                    callContext.bridge = bridge;

                    // Wait for Gemini to be ready before proceeding
                    try {
                        await bridge.readyPromise;

                        console.log(`[Twilio WS] Gemini is ready for call ${callSid}`);
                    } catch (err) {
                        console.error(`[Twilio WS] Gemini failed to initialize for call ${callSid}:`, err);
                    };

                    // Start recordings
                    callContext.inRecording = fs.createWriteStream(path.join(recordingsDir, `call_${callSid}_received.raw`));
                    callContext.outRecording = fs.createWriteStream(path.join(recordingsDir, `call_${callSid}_sent.raw`));

                    bridge.on('audio', (pcm16Buffer: Buffer) => {
                        // Record outgoing Gemini audio
                        if (callContext.outRecording)
                            callContext.outRecording.write(pcm16Buffer);

                        // Re-encode Gemini audio for media stream
                        const mulawBuffer = encodePcm16ToMulaw(pcm16Buffer);
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: mulawBuffer.toString('base64') }
                        }));
                    });

                    bridge.on('press_dtmf', (key: string) => {
                        console.log(`[Twilio WS] Gemini requested DTMF: ${key}`);
                        
                        // Generate and encode DTMF for Twilio
                        const dtmfPcm16 = generateDtmfPcm16(key, 250); 
                        const dtmfMulaw = encodePcm16ToMulaw(dtmfPcm16);

                        // Send DTMF tone over media stream
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: dtmfMulaw.toString('base64') }
                        }));
                    });

                    bridge.on('interrupted', () => {
                        console.log(`[Twilio WS] Gemini interrupted, clearing Twilio buffer`);

                        // Clear any buffered Gemini audio
                        ws.send(JSON.stringify({
                            event: 'clear',
                            streamSid: streamSid
                        }));
                    });

                    bridge.on('task_completed', (summary: string) => {
                        console.log(`[Twilio WS] Task completed. Summary: ${summary}`);

                        // Clean up all resources and return a call result
                        if (callSid) {
                            callContext.resolve(summary);

                            cleanupCall(callSid);
                        }
                    });

                    bridge.on('close', () => {
                        console.log(`[Twilio WS] Gemini connection closed for call ${callSid}`);

                        // Handle unexpected disconnects
                        if (callSid)
                            cleanupCall(callSid, new Error("Gemini connection closed."));
                    });

                    bridge.on('error', (err) => {
                        console.error(`[Gemini] Bridge error for call ${callSid}:`, err);

                        // Handle Gemini errors like invalid model names
                        if (callSid)
                            cleanupCall(callSid, err);
                    });
                } else {
                    // Reject unauthorized connections
                    console.error(`[Twilio WS] Call ${callSid} not found in active calls.`);
                    ws.close();
                }
                break;
            case 'media':
                if (bridge && callSid) {
                    const callContext = activeCalls.get(callSid);

                    // Decode incoming audio
                    const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
                    const pcm16Buffer = decodeMulawToPcm16(mulawBuffer);
                    
                    // Record incoming audio
                    if (callContext?.inRecording)
                        callContext.inRecording.write(pcm16Buffer);

                    // Forward audio to Gemini
                    bridge.sendAudio(pcm16Buffer);
                }
                break;
            case 'stop':
                console.log(`[Twilio WS] Stream stopped for call ${callSid}`);

                // Clean up resources
                cleanupCall(callSid, new Error("Call ended by user or Twilio."));
                break;
        }
    });

    ws.on('close', () => {
        console.log('[Express] Twilio Media Stream WebSocket closed unexpectedly.');

        // Handle unexpected disconnects
        cleanupCall(callSid, new Error("WebSocket closed."));
    });
}
