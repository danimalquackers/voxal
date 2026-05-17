import fs from 'fs';
import { config } from './config.js';
import { twilioClient, serverState } from './services.js';
import { activeCalls, cleanupCall } from './call-registry.js';
import { CallRequest } from './mcp-server.js';

export async function executeCall(request: CallRequest): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
        try {
            console.log(`[MCP] Executing call to ${request.targetPhoneNumber}`);
            
            // WSS url based on public URL
            const publicUrl = serverState.publicUrl;
            const wssEndpoint = publicUrl.replace('https://', 'wss://').replace('http://', 'ws://');
            const callWssEndpoint = `${wssEndpoint}/media-stream`;

            // Wait to connect the call before continuing
            const callSid = await twilioClient.makeCall(request.targetPhoneNumber, callWssEndpoint);
            
            // Extract the provided call context
            let backgroundContext = request.context;

            // Read persistent user context if it exists
            const contextPath = config.contextFile;
            if (fs.existsSync(contextPath)) {
                const userContext = fs.readFileSync(contextPath, 'utf-8');
                backgroundContext = `
                    User Information:
                    ${userContext}
                    
                    Call Specific Context:
                    ${request.context}
                `;
            }

            // Store call context so the incoming websocket can pick it up
            activeCalls.set(callSid, {
                resolve,
                reject,
                objective: request.objective,
                context: backgroundContext || "",
                recordCall: request.recordCall
            });

            // Timeout to prevent dangling calls (10 mins)
            setTimeout(() => {
                if (activeCalls.has(callSid)) {
                    console.log(`[Timeout] Call ${callSid} timed out.`);
                    twilioClient.endCall(callSid).catch(console.error);

                    // Propagate the timeout error
                    cleanupCall(callSid, new Error("Call timed out after 10 minutes."));
                }
            }, config.callTimeout * 1000);

        } catch (error) {
            reject(error);
        }
    });
}
