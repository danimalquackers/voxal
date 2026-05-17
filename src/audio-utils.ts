import pkg from 'wavefile';
const { WaveFile } = pkg;

// TODO Enable call transcripts (return after call completion as a resource link)
// TODO Provide an MCP prompt resource

/**
 * Decodes 8kHz µ-law audio to 16kHz PCM16 format required by Gemini.
 * Utilizes the wavefile package for clean conversion and resampling.
 */
export function decodeMulawToPcm16(mulawBuffer: Buffer): Buffer {
    const wav = new WaveFile();

    // Initialize with Twilio format: 1 channel, 8000Hz, 8-bit mu-law ('8m')
    wav.fromScratch(1, 8000, '8m', mulawBuffer);
    
    // Convert mu-law to 16-bit PCM
    wav.fromMuLaw();
    
    // Resample from 8kHz to 16kHz
    wav.toSampleRate(16000);
    
    // After resampling and conversion, wav.data.samples contains the raw PCM data.
    // We ensure it's returned as a Buffer.
    const samples = wav.getSamples(false, Int16Array);
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Encodes 24kHz PCM16 audio from Gemini down to 8kHz µ-law format for Twilio.
 * Gemini Live API outputs at 24kHz by default.
 */
export function encodePcm16ToMulaw(pcm16Buffer: Buffer): Buffer {
    const wav = new WaveFile();

    // Gemini outputs 16-bit PCM. We MUST pass it as an Int16Array to fromScratch
    // so wavefile doesn't treat the raw bytes as 8-bit samples.
    const samples = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, pcm16Buffer.length / 2);
    
    // Initialize with Gemini format: 1 channel, 24000Hz, 16-bit PCM ('16')
    wav.fromScratch(1, 24000, '16', samples);
    
    // Downsample from 24kHz to 8kHz
    wav.toSampleRate(8000);
    
    // Convert 16-bit PCM down to 8-bit mu-law
    wav.toMuLaw();
    
    // For 8-bit formats like mu-law, wav.data.samples is a Uint8Array
    const mulawSamples = wav.getSamples(false, Uint8Array);
    return Buffer.from(mulawSamples.buffer, mulawSamples.byteOffset, mulawSamples.byteLength);
}

const DTMF_FREQS: Record<string, [number, number]> = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
};

/**
 * Generates a 16kHz PCM16 Buffer containing a DTMF tone for the given key.
 * @param key The DTMF key (0-9, *, #)
 * @param durationMs Duration of the tone in milliseconds
 */
export function generateDtmfPcm16(key: string, durationMs: number = 250): Buffer {
    const freqs = DTMF_FREQS[key.toUpperCase()];
    if (!freqs) {
        console.warn(`[Audio] Invalid DTMF key: ${key}`);
        return Buffer.alloc(0);
    }

    const sampleRate = 16000;
    const numSamples = Math.floor((durationMs / 1000) * sampleRate);
    const pcmSamples = new Int16Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;

        // Generate DTMF tone frequences
        const val1 = Math.sin(2 * Math.PI * freqs[0] * t);
        const val2 = Math.sin(2 * Math.PI * freqs[1] * t);

        // Mix signals and scale to 16-bit range (leave some headroom)
        const sample = ((val1 + val2) / 2) * 20000;
        pcmSamples[i] = Math.floor(sample);
    }

    return Buffer.from(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);
}
