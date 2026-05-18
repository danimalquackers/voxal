import fs, { WriteStream } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { GeminiBridge, TranscriptEntry } from '../services/gemini.js';
import { decodeMulawToPcm16, encodePcm16ToMulaw, generateDtmfPcm16 } from '../utils/audio.js';
import { activeCalls, cleanupCall } from '../calls/registry.js';

const recordingsDir = config.recordingsDir;
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
}

export function handleTwilioWebSocket(ws: any, req: any) {
    console.error('[Express] WebSocket connection opened.');

    let callSid: string | null = null;
    let streamSid: string | null = null;
    let bridge: GeminiBridge | null = null;
    let isMuted = false;
    let expectedPlaybackFinishedTime = 0;
    let totalBytesReceived = 0;
    let totalBytesSent = 0;
    let callStartTime = 0;
    let lastTranscriptSpeaker: 'user' | 'agent' | null = null;
    let awaitingSummary = false;

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
                console.error(`[Twilio] Media Stream connected.`);
                break;
            case 'start':
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                console.error(`[Twilio] Stream started for call ${callSid}`);
                
                const callContext = activeCalls.get(callSid!);
                if (callContext) {
                    bridge = new GeminiBridge({
                        objective: callContext.objective,
                        context: callContext.context,
                        recordCall: callContext.recordCall,
                    });
                    
                    // Store reference for later cleanup
                    callContext.bridge = bridge;

                    // Wait for Gemini to be ready before proceeding
                    try {
                        await bridge.readyPromise;

                        console.error(`[Gemini] Ready for call ${callSid}`);
                    } catch (err) {
                        console.error(`[Gemini] Failed to initialize for call ${callSid}:`, err);
                    }

                    // Start recordings
                    if (callContext.recordCall) {
                        callContext.inRecording = fs.createWriteStream(path.join(recordingsDir, `call_${callSid}_received.raw`));
                        callContext.outRecording = fs.createWriteStream(path.join(recordingsDir, `call_${callSid}_sent.raw`));
                    }

                    // Start transcript file if transcription is enabled
                    if (config.transcription) {
                        const transcriptPath = path.join(recordingsDir, `call_${callSid}_transcript.txt`);
                        callContext.transcriptFile = fs.createWriteStream(transcriptPath);
                        callStartTime = Date.now();

                        // Write metadata header
                        const startDate = new Date().toLocaleString();
                        callContext.transcriptFile.write(`Call Transcript\n`);
                        callContext.transcriptFile.write(`Date: ${startDate}\n`);
                        callContext.transcriptFile.write(`Objective: ${callContext.objective}\n`);
                        callContext.transcriptFile.write(`${'─'.repeat(30)}\n\n`);
                    }

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
                        console.error(`[Gemini] Requested DTMF: ${key}`);
                        
                        // Generate and encode DTMF for Twilio
                        const dtmfPcm16 = generateDtmfPcm16(key, 250); 

                        // Record DTMF audio with silence alignment
                        recordOutgoingAudio(dtmfPcm16, callContext.outRecording);

                        // Send DTMF tone over media stream
                        sendOutgoingAudio(dtmfPcm16);
                    });

                    bridge.on('transcript', (entry: TranscriptEntry) => {
                        if (!callContext.transcriptFile || !entry.text.trim()) return;

                        // Calculate timestamps for every transcript entry
                        const elapsedSec = Math.floor((Date.now() - callStartTime) / 1000);
                        const min = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
                        const sec = (elapsedSec % 60).toString().padStart(2, '0');
                        const timestamp = `[${min}:${sec}]`;
                        const label = entry.speaker === 'user' ? 'User' : 'Agent';

                        if (lastTranscriptSpeaker !== entry.speaker) {
                            // New speaker
                            if (lastTranscriptSpeaker !== null)
                                callContext.transcriptFile.write('\n');

                            callContext.transcriptFile.write(`${timestamp} ${label}: ${entry.text.trim()}`);
                            lastTranscriptSpeaker = entry.speaker;
                        } else {
                            // Same speaker, append
                            callContext.transcriptFile.write(` ${entry.text.trim()}`);
                        }
                    });

                    bridge.on('interrupted', () => {
                        console.error(`[Gemini] Interrupted, clearing playback buffer`);

                        // Clear any buffered Gemini audio
                        ws.send(JSON.stringify({
                            event: 'clear',
                            streamSid: streamSid
                        }));
                    });

                    bridge.on('task_completed', (summary: string) => {
                        console.error(`[Gemini] Task completed. Summary: ${summary}`);

                        // Buffer time in ms for any final Gemini audio to stream
                        const PLAYBACK_GRACE_PERIOD = 500;

                        // Grace period to allow goodbye to finish streaming from Gemini
                        setTimeout(() => {
                            isMuted = true;
                            checkAndHangup();

                            console.error(`[Gemini] Goodbye grace period ended, muting stream`);
                        }, PLAYBACK_GRACE_PERIOD);

                        // Complete call hangup after the receiver has heard the full goodbye
                        const checkAndHangup = () => {
                            const now = Date.now();
                            const remainingMs = expectedPlaybackFinishedTime - now;

                            if (remainingMs > 0) {
                                const waitTime = remainingMs + PLAYBACK_GRACE_PERIOD;

                                console.error(`[Twilio] Playback queue not empty, waiting ${waitTime}ms for playback to complete...`);
                                setTimeout(checkAndHangup, waitTime);
                            } else {
                                if (callSid) {
                                    console.error(`[Twilio] Call complete. Hanging up ${callSid}`);

                                    // Cache the summary in the call context
                                    callContext.summary = summary;

                                    callContext.resolve(callSid);
                                    cleanupCall(callSid);
                                }
                            }
                        };
                    });

                    bridge.on('close', () => {
                        console.error(`[Gemini] Connection closed for call ${callSid}`);

                        // Only treat as error if we weren't awaiting a summary
                        if (callSid && !awaitingSummary)
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
                console.error(`[Twilio] Stream stopped for call ${callSid}`);

                // Mute the audio stream, no more audio can be sent
                isMuted = true;

                if (bridge && callSid && activeCalls.has(callSid)) {
                    // Ask Gemini to summarize and call task_completed
                    awaitingSummary = true;
                    bridge.notifyDisconnect();
                } else {
                    cleanupCall(callSid, new Error("Call ended by user or Twilio."));
                }
                break;
        }
    });

    ws.on('close', () => {
        // If we're waiting for Gemini's summary, don't clean up yet
        if (awaitingSummary) {
            console.error('[Express] WebSocket closed, awaiting Gemini summary...');
            return;
        }

        console.error('[Express] WebSocket closed unexpectedly.');

        // Handle unexpected disconnects
        cleanupCall(callSid, new Error("WebSocket closed."));
    });
}
