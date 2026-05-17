import fs from 'fs';
import { GeminiBridge } from '../services/gemini.js';
import { twilioClient } from '../services/shared.js';

export interface CallContext {
    resolve: (summary: string) => void;
    reject: (err: any) => void;
    bridge?: GeminiBridge;
    objective: string;
    context: string;
    recordCall?: boolean;
    inRecording?: fs.WriteStream;
    outRecording?: fs.WriteStream;
}

export const activeCalls = new Map<string, CallContext>();

export function getCalls(limit?: number) {
    return twilioClient.getCalls(limit);
}

export async function cleanupCall(sid: string | null, error?: Error) {
    if (sid && activeCalls.has(sid)) {
        const callContext = activeCalls.get(sid);
        if (callContext) {
            console.log(`[Cleanup] Cleaning up call ${sid}${error ? `: ${error.message}` : ''}`);

            // End the Twilio call explicitly if not already ended
            await twilioClient.endCall(sid).catch(() => { });

            // Destroy connected bridge and end recordings
            if (callContext.bridge) callContext.bridge.close();
            if (callContext.inRecording) callContext.inRecording.end();
            if (callContext.outRecording) callContext.outRecording.end();

            if (error) {
                callContext.reject(error);
            }
        }
        activeCalls.delete(sid);
    }
}
