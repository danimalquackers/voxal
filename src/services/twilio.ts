import twilio from 'twilio';

export interface TwilioClientOptions {
    accountSid?: string;
    authToken?: string;
    phoneNumber?: string;
}

export class TwilioClient {
    private client: twilio.Twilio;
    private fromNumber: string;

    constructor(options: TwilioClientOptions = {}) {
        const accountSid = options.accountSid;
        const authToken = options.authToken;
        const fromNumber = options.phoneNumber;

        if (!accountSid || !authToken || !fromNumber) {
            throw new Error('[Twilio] Missing credentials (accountSid, authToken, phoneNumber must be specified)');
        }

        // Initializes the Twilio SDK client
        this.client = twilio(accountSid, authToken);
        this.fromNumber = fromNumber;
    }

    /**
     * Initiates an outbound call using Twilio, connecting it immediately to a Media Stream.
     */
    public async makeCall(to: string, wssUrl: string): Promise<string> {
        console.error(`[Twilio] Starting call to ${to}`);
        
        // Use inline TwiML to start the stream immediately
        const twiml = `
            <Response>
                <Connect>
                    <Stream url="${wssUrl}" />
                </Connect>
            </Response>
        `;

        // Starts the new call with the generated TwiML
        const call = await this.client.calls.create({
            twiml: twiml,
            to: to,
            from: this.fromNumber
        });

        console.error(`[Twilio] Call started: ${call.sid}`);
        return call.sid;
    }

    /**
     * Ends an active Twilio call.
     */
    public async endCall(callSid: string): Promise<void> {
        try {
            await this.client.calls(callSid).update({ status: 'completed' });

            console.error(`[Twilio] Call ended: ${callSid}`);
        } catch (error) {
            console.error(`[Twilio] Failed to end call ${callSid}:`, error);
        }
    }

    /**
     * Fetches call history from Twilio.
     */
    public async getCalls(limit: number = 20) {
        try {
            console.error('[Twilio] Fetching call history...');

            const calls = await this.client.calls.list({ limit });
            return calls.map(c => ({
                sid: c.sid,
                from: c.from,
                to: c.to,
                status: c.status,
                startTime: c.startTime,
                duration: c.duration,
                direction: c.direction
            }));
        } catch (error) {
            console.error(`[Twilio] Failed to fetch call history:`, error);
            throw error;
        }
    }
}
