import { TwilioClient } from './twilio-client.js';
import { config } from './config.js';

export const twilioClient = new TwilioClient(config.twilio);

export const serverState = {
    publicUrl: ""
};
