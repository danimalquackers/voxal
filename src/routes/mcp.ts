import { createMcpServer } from '../services/mcp.js';
import { executeCall } from '../calls/handler.js';
import { getCalls } from '../calls/registry.js';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { randomUUID } from 'crypto';
import express from 'express';

// Map to track active MCP sessions
export const activeSessions = new Map<string, { server: McpServer, transport: NodeStreamableHTTPServerTransport, lastSeen: number }>();

// Cleanup stale sessions every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions.entries()) {
        if (now - session.lastSeen > CLEANUP_INTERVAL_MS) {
            console.log(`[MCP] Cleaning up stale session: ${id}`);

            // Ignore errors, forcefully remove the session
            session.transport.close().catch(() => {});
            activeSessions.delete(id);
        }
    }
}, CLEANUP_INTERVAL_MS);

export async function handleMcpRequest(req: express.Request, res: express.Response) {
    // Load existing session if available
    const sessionId = req.header("mcp-session-id");
    let session = sessionId ? activeSessions.get(sessionId) : undefined;

    // MCP clients must provide a session ID or request a session
    if (!session && sessionId) {
        console.warn(`[MCP] Session not found: ${sessionId}`);
        return res.status(404).send("Session not found");
    }

    try {
        if (!session) {
            console.log(`[MCP] Establishing new session...`);

            // Generate a new session bound to a UUID
            const transport = new NodeStreamableHTTPServerTransport({ 
                sessionIdGenerator: () => randomUUID() 
            });
            
            // Create a new MCP server instance for this session
            const sessionServer = createMcpServer(executeCall, getCalls);
            await sessionServer.connect(transport);
            
            // Handle the initial setup request
            await transport.handleRequest(req, res, req.body);
            
            // If registration completed successfully, save the session
            const id = transport.sessionId;
            if (id) {
                activeSessions.set(id, { 
                    server: sessionServer, 
                    transport, 
                    lastSeen: Date.now() 
                });
                
                transport.onclose = () => {
                    console.log(`[MCP] Session closed: ${id}`);
                    activeSessions.delete(id);
                };
                
                console.log(`[MCP] Session established: ${id}`);
            }
        } else {
            session.lastSeen = Date.now();

            // Forward request to the existing session
            await session.transport.handleRequest(req, res, req.body);
        }
    } catch (err) {
        console.error(`[MCP] Request error:`, err);
        if (!res.headersSent) {
            res.status(500).send("Internal Server Error");
        }
    }
}

export async function initStdioMcp() {
    if (process.env.ENABLE_STDIO === 'true') {
        console.log(`[MCP] Starting stdio transport...`);
        
        // No mapping needed for stdio
        const stdioTransport = new StdioServerTransport();
        
        // Instantiates a single MCP server for stdio usage
        const stdioMcpServer = createMcpServer(executeCall, getCalls);
        await stdioMcpServer.connect(stdioTransport);
    }
}
