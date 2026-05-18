import { GoogleGenAI, Modality, Session, Type } from '@google/genai';
import { EventEmitter } from 'events';
import { config } from '../config.js';

export interface GeminiBridgeOptions {
    objective: string;
    context?: string;
    recordCall?: boolean;
}

export interface TranscriptEntry {
    speaker: 'user' | 'agent';
    text: string;
}

const systemInstruction = `
    You are an autonomous AI voice agent making a phone call. You must
    speak clearly, concisely, and act human-like over the phone. You
    must introduce yourself as an assistant working on behalf of your
    client. Be prepared to navigate IVR menus using the press_dtmf
    tool. When you have achieved your objective or the call needs to
    end, you MUST politely say goodbye and use the task_completed
    tool to hang up. Remember you are talking to someone other than
    your client, so don't say things like "task completed" or "data
    collected".
`;

export class GeminiBridge extends EventEmitter {
    private ai: GoogleGenAI;
    private session?: Session;
    private options: GeminiBridgeOptions;

    public readyPromise: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (error: Error) => void;
    public isReady: boolean = false;

    constructor(options: GeminiBridgeOptions) {
        super();

        this.options = options;

        // Connect to Gemini API
        this.ai = new GoogleGenAI({ apiKey: config.apiKey });
        
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });

        console.error(`[Gemini] Connecting to ${config.model}...`);
        this.connect();
    }

    private async connect() {
        try {
            const {
                recordCall,
                objective,
                context
            } = this.options;

            // Include a notice for two-party states
            const recordingNotice = recordCall
                ? `
                    IMPORTANT: THIS CALL IS BEING RECORDED. You MUST
                    notify the other party at the very beginning of
                    the conversation that 'This call is being recorded'
                    (or similar).
                `
                : "";

            // Assemble the system prompt based on the options provided
            const prompt = `
                ${systemInstruction}
                
                ${recordingNotice}

                ${config.systemPrompt || ""}
                
                Your objective is: ${objective}
                Additional context from the user: ${context || 'None'}
            `;

            // Build the Live session config
            const liveConfig: any = {
                responseModalities: [ Modality.AUDIO ],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: config.voice
                        }
                    }
                },
                systemInstruction: {
                    parts: [{
                        text: prompt
                    }]
                },
                tools: [{
                    functionDeclarations: [
                        {
                            name: 'task_completed',
                            description: 'Call this function when the task is complete to hang up the phone and provide a summary of the outcome.',
                            parameters: {
                                type: Type.OBJECT,
                                properties: {
                                    summary: {
                                        type: Type.STRING,
                                        description: 'A brief summary of what was achieved.'
                                    }
                                },
                                required: ['summary']
                            }
                        },
                        {
                            name: 'press_dtmf',
                            description: 'Press a DTMF key (dial pad button). Use this to navigate phone menus or enter extensions.',
                            parameters: {
                                type: Type.OBJECT,
                                properties: {
                                    digit: {
                                        type: Type.STRING,
                                        description: 'The digit to press (0-9, *, #)'
                                    }
                                },
                                required: ['digit']
                            }
                        }
                    ]
                }]
            };

            // Enable native speech-to-text transcription if requested
            if (config.transcription) {
                liveConfig.inputAudioTranscription = {};
                liveConfig.outputAudioTranscription = {};
            }

            // Establish and configure the Live session
            this.session = await this.ai.live.connect({
                model: config.model,
                config: liveConfig,
                callbacks: {
                    onopen: () => {
                        console.error('[Gemini] Connection established');
                    },
                    onmessage: this.handleMessage.bind(this),
                    onerror: this.handleError.bind(this),
                    onclose: this.handleClose.bind(this),
                }
            });
        } catch (error) {
            console.error('[Gemini] Connection error:', error);

            // Propagate the error
            this.rejectReady(error as Error);
            this.emit('error', error);
        }
    }

    public sendAudio(pcm16Buffer: Buffer) {
        if (!this.isReady || !this.session) return;

        // Forward an audio chunk to the Live API
        this.session.sendRealtimeInput({
            audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: pcm16Buffer.toString('base64')
            }
        });
    }

    /**
     * Notifies Gemini that the other party has disconnected,
     * instructing it to immediately call task_completed with a summary.
     */
    public notifyDisconnect() {
        if (!this.session) return;

        console.error('[Gemini] Notifying disconnect, requesting summary...');

        this.session.sendClientContent({
            turns: [{
                role: 'user',
                parts: [{
                    text: `
                        The other party has disconnected from the call.
                        Do not generate any more audio. Process all of
                        the remaining user input and call 'task_completed'
                        immediately with a summary of what was
                        accomplished during this call.
                    `
                }]
            }],
            turnComplete: true
        });
    }

    private handleMessage(message: any) {
        try {
            // Handle setup response
            if (message.setupComplete) {
                console.error('[Gemini] Session started');
                
                // Propagate the connection success
                this.isReady = true;
                this.resolveReady();
                
                return;
            }

            // Handle model updates
            if (message.serverContent) {
                const content = message.serverContent;

                // Emit transcription events (user speech-to-text)
                if (content.inputTranscription?.text) {
                    const text = content.inputTranscription.text;

                    console.error(`[Transcript] User: ${text}`);
                    this.emit('transcript', { speaker: 'user', text } as TranscriptEntry);
                }

                // Emit transcription events (model speech-to-text)
                if (content.outputTranscription?.text) {
                    const text = content.outputTranscription.text;

                    console.error(`[Transcript] Agent: ${text}`);
                    this.emit('transcript', { speaker: 'agent', text } as TranscriptEntry);
                }
                
                // No-op warning for interruptions
                if (content.interrupted) {
                    console.error('[Gemini] Model interrupted');
                    this.emit('interrupted');
                }
                
                // Parse the list of model actions performed
                if (content.modelTurn) {
                    const parts = content.modelTurn.parts || [];

                    for (const part of parts) {
                        // Forward generated audio chunks
                        if (part.inlineData) {
                            const data = part.inlineData;

                            if (data.mimeType?.startsWith('audio/pcm')) {
                                const audioBuffer = Buffer.from(data.data, 'base64');
                                this.emit('audio', audioBuffer);
                            }
                        }
                        
                        // Forward function calls
                        if (part.functionCall) {
                            this.handleFunctionCall(part.functionCall);
                        }
                    }
                }
            } else if (message.toolCall) {
                // Forward function calls
                const calls = message.toolCall.functionCalls || [];

                for (const call of calls) {
                    this.handleFunctionCall(call);
                }
            } else if (message.sessionResumptionUpdate) {
                // No-op, session resumption is not needed
            } else {
                console.error('[Gemini] Other message received:', JSON.stringify(message).substring(0, 100));
            }
        } catch (error) {
            console.error('[Gemini] Message parsing error:', error);
        }
    }

    private handleFunctionCall(functionCall: any) {
        const { name, args, id } = functionCall;
        console.error(`[Gemini] Tool call: ${name}`, args);
        
        // Propagate tool calls
        if (name === 'task_completed') {
            this.emit('task_completed', args.summary);
        } else if (name === 'press_dtmf') {
            this.emit('press_dtmf', args.digit || args.key);
        }

        if (id)
            this.sendToolResponse(id, name, { success: true });
    }

    private sendToolResponse(id: string, name: string, response: any) {
        if (!this.session) return;

        // Format tool responses (mocked, because they are triggered asynchronously)
        this.session.sendToolResponse({
            functionResponses: [{
                id: id,
                name: name,
                response: { output: response }
            }]
        });
    }

    private handleClose(event: any) {
        console.error(`[Gemini] Session ended.`);
        this.emit('close');

        if (!this.isReady)
            this.rejectReady(new Error(`Gemini connection closed during setup`));
    }

    private handleError(error: any) {
        console.error('[Gemini] Session error:', error);
        this.emit('error', error);

        if (!this.isReady)
            this.rejectReady(error);
    }

    public close() {
        if (this.session)
            this.session.close();
    }
}
