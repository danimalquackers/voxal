import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import path from "path";

// Parse arguments with yargs
const argv = yargs(hideBin(process.argv))
    .option("model", {
        alias: "m",
        type: "string",
        description: "Gemini model ID",
        default: process.env.VOXAL_GEMINI_MODEL || "gemini-3.1-flash-live-preview",
    })
    .option("voice", {
        alias: "v",
        type: "string",
        description: "Gemini voice to use",
        default: process.env.VOXAL_GEMINI_VOICE || "Fenrir",
    })
    .option("context-file", {
        alias: "c",
        type: "string",
        description: "Path to persistent user context file",
        default: process.env.VOXAL_CONTEXT_FILE || path.join(process.cwd(), "user_context.txt"),
    })
    .option("recordings-dir", {
        alias: "r",
        type: "string",
        description: "Directory for call audio recordings",
        default: process.env.VOXAL_RECORDINGS_DIR || path.join(process.cwd(), "recordings"),
    })
    .option("port", {
        alias: "p",
        type: "number",
        description: "Server listening port",
        default: Number(process.env.PORT) || 3000,
    })
    .option("host", {
        alias: "l",
        type: "string",
        description: "Server listening host interface",
        default: process.env.HOST || "127.0.0.1",
    })
    .option("ngrok-authtoken", {
        type: "string",
        description: "Ngrok Authtoken",
        default: process.env.NGROK_AUTHTOKEN,
        required: true,
    })
    .option("ngrok-domain", {
        type: "string",
        description: "Ngrok Custom Domain (optional)",
        default: process.env.NGROK_DOMAIN,
    })
    .option("twilio-account-sid", {
        type: "string",
        description: "Twilio Account SID",
        default: process.env.TWILIO_ACCOUNT_SID,
        required: true,
    })
    .option("twilio-auth-token", {
        type: "string",
        description: "Twilio Auth Token",
        default: process.env.TWILIO_AUTH_TOKEN,
        required: true,
    })
    .option("twilio-phone-number", {
        type: "string",
        description: "Twilio Phone Number to call from",
        default: process.env.TWILIO_PHONE_NUMBER,
        required: true,
    })
    .option("call-timeout", {
        type: "number",
        description: "Call timeout in seconds",
        default: Number(process.env.VOXAL_CALL_TIMEOUT) || 10 * 60,
    })
    .option("gemini-api-key", {
        type: "string",
        description: "Gemini API Key",
        default: process.env.GEMINI_API_KEY,
        required: true,
    })
    .help()
    .parseSync();

/**
 * Priority: 
 * 1. Command line arguments/flags
 * 2. Environment variables (or .env via node --env-file)
 * 3. Defaults
 */
export const config = {
    // Gemini settings
    model: argv.model,
    voice: argv.voice,

    // Path to the persistent user context file
    contextFile: argv["context-file"],

    // Directory where audio recordings are stored
    recordingsDir: argv["recordings-dir"],

    // Server networking
    port: argv["port"],
    host: argv["host"],

    // Ngrok configuration
    ngrok: {
        authtoken: argv["ngrok-authtoken"],
        domain: argv["ngrok-domain"],
    },

    // Twilio configuration
    twilio: {
        accountSid: argv["twilio-account-sid"],
        authToken: argv["twilio-auth-token"],
        phoneNumber: argv["twilio-phone-number"],
    },

    // Call timeout in seconds
    callTimeout: argv["call-timeout"],

    // Gemini API Key
    apiKey: argv["gemini-api-key"],
};

console.log("[Config] Active configuration:", {
    model: config.model,
    contextFile: config.contextFile,
    recordingsDir: config.recordingsDir,
    port: config.port,
    host: config.host,
    ngrokDomain: config.ngrok.domain || "ephemeral",
    twilioNumber: config.twilio.phoneNumber
});
