import fs from "fs";
import path from "path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../config.js";
import { activeCalls } from "../calls/registry.js";

// Define the shape of the call request
export interface CallRequest {
    targetPhoneNumber: string;
    objective: string;
    context?: string;
    recordCall?: boolean;
}

// Tool definitions
export type ExecuteCallFn = (request: CallRequest) => Promise<string>;
export type GetCallHistoryFn = (limit?: number) => Promise<any[]>;

export function createMcpServer(executeCall: ExecuteCallFn, getCallHistory: GetCallHistoryFn) {
    const server = new McpServer({
        name: "Voxal MCP Server",
        version: "1.0.0",
    });

    server.registerTool(
        "execute_phone_call",
        {
            description: "Place a phone call to a target number using a voice agent. The agent will accomplish the given objective and return a summary of the outcome.",
            inputSchema: z.object({
                target_phone_number: z.string().describe("The phone number to call (E.164 format, e.g., +1234567890)"),
                objective: z.string().describe("The clear, primary objective the voice agent should accomplish on the call (e.g., 'Ask if they have Vyvanse 20mg in stock')."),
                context: z.string().optional().describe("Optional background context or details the agent might need to answer questions from the receiver."),
                record_call: z.boolean().optional().default(false).describe("If true, the call will be recorded. The agent will notify the recipient at the start of the call.")
            })
        },
        async (args: any) => {
            console.log(`[MCP] Tool invoked: execute_phone_call to ${args.target_phone_number} (Record: ${args.record_call})`);
            try {
                // Place the call and wait for it to complete
                const sid = await executeCall({
                    targetPhoneNumber: args.target_phone_number,
                    objective: args.objective,
                    context: args.context || 'None provided',
                    recordCall: args.record_call
                });

                // Retrieve the call summary
                const callContext = activeCalls.get(sid);
                const summary = callContext?.summary || "No summary available";

                return {
                    content: [
                        {
                            type: "text",
                            text: `Call Completed. Summary:\n${summary}`
                        },
                        {
                            type: "resource_link",
                            uri: `transcript://${sid}`,
                            name: sid,
                            mimeType: "text/plain",
                        }
                    ]
                };
            } catch (error) {
                console.error("[MCP] execute_phone_call failed:", error);
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: `Failed to execute phone call: ${error instanceof Error ? error.message : String(error)}`
                    }]
                };
            }
        }
    );

    server.registerTool(
        "get_call_history",
        {
            description: "Retrieves a list of recent phone calls and their current status.",
            inputSchema: z.object({
                limit: z.number().optional().default(20).describe("Maximum number of calls to retrieve.")
            })
        },
        async (args: any) => {
            console.log(`[MCP] Tool invoked: get_call_history (Limit: ${args.limit})`);
            try {
                const history = await getCallHistory(args.limit);
                return {
                    content: [{ type: "text", text: JSON.stringify(history, null, 2) }]
                };
            } catch (error) {
                console.error("[MCP] get_call_history failed:", error);
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to fetch call history: ${error instanceof Error ? error.message : String(error)}` }]
                };
            }
        }
    );

    server.registerResource(
        "transcript",
        new ResourceTemplate("transcript://{sid}", {
            list: async () => {
                // Retrieve the list of transcript files
                const files = fs.globSync(path.join(config.recordingsDir, "call_*_transcript.txt"));

                return {
                    resources: files.map((file) => {
                        // Extract the sid from the filename
                        const filename = path.basename(file);
                        const sid = filename.substring("call_".length, filename.length - "_transcript.txt".length);

                        // Return a usable URI
                        return {
                            uri: `transcript://${sid}`,
                            name: sid
                        };
                    })
                }
            },
        }),
        {
            title: "Call Transcript",
            description: "Retrieves the transcript of a specific call.",
            mimeType: "text/plain",
        },
        async (uri, { sid }) => {
            console.log(`[MCP] Retrieving transcript for call ${sid}`);
            try {
                // Try to read the transcript file if it exists
                const transcriptFile = `${config.recordingsDir}/call_${sid}_transcript.txt`;
                if (fs.existsSync(transcriptFile)) {
                    const transcript = fs.readFileSync(transcriptFile, 'utf-8');

                    return {
                        contents: [{
                            uri: uri.href,
                            text: transcript,
                        }]
                    };
                } else {
                    return {
                        isError: true,
                        contents: [{ uri: uri.href, text: `Transcript not found for call ${sid}` }]
                    };
                }
            } catch (error) {
                console.error("[MCP] get_call_transcript failed:", error);
                return {
                    isError: true,
                    contents: [{ uri: uri.href, text: `Failed to fetch call transcript: ${error instanceof Error ? error.message : String(error)}` }]
                };
            }
        }
    )

    server.registerPrompt(
        "agent_call",
        {
            title: "Agent Phone Call",
            description: "Place a phone call and have an agent complete the provided objective",
            argsSchema: z.object({
                number: z.string().describe("The phone number to call (E.164 format, e.g., +1234567890)"),
                objective: z.string().describe("The primary objective the voice agent should accomplish on the call"),
                context: z.string().optional().describe("Optional context the agent might need to answer questions from the receiver."),
            }),
        },
        ({ number, objective, context }) => {
            let prompt = `
                Call ${number} and complete the following objective:
                ${objective}
            `;

            if (context)
                prompt += `
                    In case you need it, here is some additional information
                    about the user: ${context}
                `;

            return {
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `
                                Call ${number} and complete the following objective: ${objective}

                                ${context ? `In case you need it, here is some additional information about the user: ${context}` : ""}
                            `
                        }
                    }
                ]
            };
        }
    )

    return server;
}
