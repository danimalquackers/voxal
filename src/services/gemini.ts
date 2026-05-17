import { GoogleGenAI, Modality, Session, Type } from '@google/genai';
import { EventEmitter } from 'events';

export interface GeminiBridgeOptions {
    apiKey: string;
    model: string;
    voice: string;
    objective: string;
    context?: string;
    recordCall?: boolean;
}

const systemInstruction = `
    You are an autonomous AI voice agent making a phone call. You must
    speak clearly, concisely, and act human-like over the phone. You
    must introduce yourself as an assistant working on behalf of your
    client. Be prepared to navigate IVR menus using the press_dtmf
    tool. When you have achieved your objective or the call needs to
    end, you MUST politely excuse yourself and use the task_completed
    tool to hang up.
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
        this.ai = new GoogleGenAI({ apiKey: this.options.apiKey });
        
        // Configure the model settings
        const model = this.options.model;
        
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = () => {
                console.log('[Gemini] Bridge ready (resolveReady called)');
                resolve();
            };
            this.rejectReady = (err) => {
                console.log(`[Gemini] Bridge failed (rejectReady called): ${err.message}`);
                reject(err);
            };
        });

        console.log(`[Gemini] Connecting to model ${model}`);
        this.connect(model);
    }

    private async connect(model: string) {
        try {
            const voice = this.options.voice;

            // Include a notice for two-party states
            const recordingNotice = this.options.recordCall 
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
                
                Your objective is: ${this.options.objective}
                Additional context from the user: ${this.options.context || 'None'}
            `;

            // Establish and configure the Live session
            this.session = await this.ai.live.connect({
                model: model,
                config: {
                    responseModalities: [ Modality.AUDIO ],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: voice
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
                },
                callbacks: {
                    onopen: () => {
                        console.log('[Gemini] WebSocket connection opened');
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

    private handleMessage(message: any) {
        try {
            // Handle setup response
            if (message.setupComplete) {
                console.log('[Gemini] Setup complete. AI is ready to listen.');
                
                // Propagate the connection success
                this.isReady = true;
                this.resolveReady();
                
                return;
            }

            // Handle model updates
            if (message.serverContent) {
                const content = message.serverContent;
                
                // No-op warning for interruptions
                if (content.interrupted) {
                    console.log('[Gemini] Model interrupted.');
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
            } else {
                console.log('[Gemini] Received other message:', JSON.stringify(message).substring(0, 500));
            }
        } catch (error) {
            console.error('[Gemini] Error handling message:', error);
        }
    }

    private handleFunctionCall(functionCall: any) {
        const { name, args, id } = functionCall;
        console.log(`[Gemini] Function call received: ${name}`, args);
        
        if (name === 'task_completed') {
            // Propagate call completion
            this.emit('task_completed', args.summary);

            if (id) this.sendToolResponse(id, name, { success: true });
        } else if (name === 'press_dtmf') {
            // Trigger DTMF key presses over the Twilio websocket
            this.emit('press_dtmf', args.digit || args.key);

            if (id) this.sendToolResponse(id, name, { success: true });
        }
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
        console.log(`[Gemini] Session closed.`, event);
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
