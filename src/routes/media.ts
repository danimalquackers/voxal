import fs, { WriteStream } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { GeminiBridge } from '../services/gemini.js';
import { decodeMulawToPcm16, encodePcm16ToMulaw, generateDtmfPcm16 } from '../utils/audio.js';
import { activeCalls, cleanupCall } from '../calls/registry.js';

const recordingsDir = config.recordingsDir;
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
}

export function handleTwilioWebSocket(ws: any, req: any) {
    console.log('[Express] WebSocket connection opened.');

    let callSid: string | null = null;
    let streamSid: string | null = null;
    let bridge: GeminiBridge | null = null;
    let isMuted = false;
    let expectedPlaybackFinishedTime = 0;
    let totalBytesReceived = 0;
    let totalBytesSent = 0;

    const recordOutgoingAudio = (pcm16Buffer: Buffer, outRecording?: WriteStream) => {
        if (outRecording) {
            // Create gaps between Gemini audio chunks
            const gapBytes = totalBytesReceived - totalBytesSent;
            if (gapBytes > 0) {
                outRecording.write(Buffer.alloc(gapBytes));
                totalBytesSent += gapBytes;
            }

            outRecording.write(pcm16Buffer);
            totalBytesSent += pcm16Buffer.length;
        }
    };

    const sendOutgoingAudio = (pcm16Buffer: Buffer) => {
        // Re-encode PCM16 to send over media stream
        const mulawBuffer = encodePcm16ToMulaw(pcm16Buffer);

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mulawBuffer.toString('base64') }
        }));
    };

    ws.on('message', async (message: string) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case 'connected':
                console.log(`[Twilio] Media Stream connected.`);
                break;
            case 'start':
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                console.log(`[Twilio] Stream started for call ${callSid}`);
                
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

                        console.log(`[Gemini] Ready for call ${callSid}`);
                    } catch (err) {
                        console.error(`[Gemini] Failed to initialize for call ${callSid}:`, err);
                    }

                    // Start recordings
                    callContext.inRecording = fs.createWriteStream(path.join(recordingsDir, `call_${callSid}_received.raw`));
                    callContext.outRecording = fs.createWriteStream(path.join(recordingsDir, `call_${callSid}_sent.raw`));

                    bridge.on('audio', (pcm16Buffer: Buffer) => {
                        if (isMuted) return;

                        // Calculate exact duration of this PCM16 chunk in milliseconds
                        const chunkDurationMs = pcm16Buffer.length / 32;

                        // Keep track of the expected playback duration
                        const now = Date.now();
                        if (now > expectedPlaybackFinishedTime) {
                            expectedPlaybackFinishedTime = now + chunkDurationMs;
                        } else {
                            expectedPlaybackFinishedTime += chunkDurationMs;
                        }

                        // Record outgoing Gemini audio with gaps
                        recordOutgoingAudio(pcm16Buffer, callContext.outRecording);

                        // Re-encode Gemini audio for media stream
                        sendOutgoingAudio(pcm16Buffer);
                    });

                    bridge.on('press_dtmf', (key: string) => {
                        console.log(`[Gemini] Requested DTMF: ${key}`);
                        
                        // Generate and encode DTMF for Twilio
                        const dtmfPcm16 = generateDtmfPcm16(key, 250); 

                        // Record DTMF audio with silence alignment
                        recordOutgoingAudio(dtmfPcm16, callContext.outRecording);

                        // Send DTMF tone over media stream
                        sendOutgoingAudio(dtmfPcm16);
                    });

                    bridge.on('interrupted', () => {
                        console.log(`[Gemini] Interrupted, clearing playback buffer`);

                        // Clear any buffered Gemini audio
                        ws.send(JSON.stringify({
                            event: 'clear',
                            streamSid: streamSid
                        }));
                    });

                    bridge.on('task_completed', (summary: string) => {
                        console.log(`[Gemini] Task completed. Summary: ${summary}`);

                        // Buffer time in ms for any final Gemini audio to stream
                        const PLAYBACK_GRACE_PERIOD = 500;

                        // Grace period to allow goodbye to finish streaming from Gemini
                        setTimeout(() => {
                            isMuted = true;
                            checkAndHangup();

                            console.log(`[Gemini] Goodbye grace period ended, muting stream`);
                        }, PLAYBACK_GRACE_PERIOD);

                        // Complete call hangup after the receiver has heard the full goodbye
                        const checkAndHangup = () => {
                            const now = Date.now();
                            const remainingMs = expectedPlaybackFinishedTime - now;

                            if (remainingMs > 0) {
                                const waitTime = remainingMs + PLAYBACK_GRACE_PERIOD;

                                console.log(`[Twilio] Playback queue not empty, waiting ${waitTime}ms for playback to complete...`);
                                setTimeout(checkAndHangup, waitTime);
                            } else {
                                if (callSid) {
                                    console.log(`[Twilio] Call complete. Hanging up ${callSid}`);

                                    callContext.resolve(summary);
                                    cleanupCall(callSid);
                                }
                            }
                        };
                    });

                    bridge.on('close', () => {
                        console.log(`[Gemini] Connection closed for call ${callSid}`);

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
                    console.error(`[Twilio] Call ${callSid} not found in active calls.`);
                    ws.close();
                }
                break;
            case 'media':
                if (bridge && callSid && !isMuted) {
                    const callContext = activeCalls.get(callSid);

                    // Decode incoming audio
                    const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
                    const pcm16Buffer = decodeMulawToPcm16(mulawBuffer);
                    
                    // Record incoming audio
                    if (callContext?.inRecording) {
                        callContext.inRecording.write(pcm16Buffer);
                        totalBytesReceived += pcm16Buffer.length;
                    }

                    // Forward audio to Gemini
                    bridge.sendAudio(pcm16Buffer);
                }
                break;
            case 'stop':
                console.log(`[Twilio] Stream stopped for call ${callSid}`);

                // Clean up resources
                cleanupCall(callSid, new Error("Call ended by user or Twilio."));
                break;
        }
    });

    ws.on('close', () => {
        console.log('[Express] WebSocket closed unexpectedly.');

        // Handle unexpected disconnects
        cleanupCall(callSid, new Error("WebSocket closed."));
    });
}
