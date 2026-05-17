import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

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
                const summary = await executeCall({
                    targetPhoneNumber: args.target_phone_number,
                    objective: args.objective,
                    context: args.context || 'None provided',
                    recordCall: args.record_call
                });

                return {
                    content: [{ type: "text", text: `Call Completed. Summary:\n${summary}` }]
                };
            } catch (error) {
                console.error("[MCP] execute_phone_call failed:", error);
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to execute phone call: ${error instanceof Error ? error.message : String(error)}` }]
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

    return server;
}
