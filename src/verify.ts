import * as ed from '@noble/ed25519';
import type { SigningKeyInfo, VerifyResult } from './types';

// Cache public key for 1 hour
let cachedKey: { key: Uint8Array; fetchedAt: number } | null = null;
const KEY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch the Arke public key from the well-known endpoint
 */
export async function getArkePublicKey(apiBase: string): Promise<Uint8Array> {
  // Check cache
  if (cachedKey && Date.now() - cachedKey.fetchedAt < KEY_CACHE_TTL) {
    return cachedKey.key;
  }

  const response = await fetch(`${apiBase}/.well-known/signing-key`);
  if (!response.ok) {
    throw new Error(`Failed to fetch signing key: ${response.status}`);
  }

  const data = (await response.json()) as SigningKeyInfo;

  if (data.algorithm !== 'ed25519') {
    throw new Error(`Unsupported algorithm: ${data.algorithm}`);
  }

  // Decode hex public key
  const keyBytes = hexToBytes(data.public_key);
  cachedKey = { key: keyBytes, fetchedAt: Date.now() };

  return keyBytes;
}

/**
 * Parse the X-Arke-Signature header
 * Format: t=<timestamp>,v1=<signature>
 */
export function parseSignatureHeader(
  header: string
): { timestamp: number; signature: string } | null {
  const parts = header.split(',');

  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = parseInt(value, 10);
    } else if (key === 'v1') {
      signature = value;
    }
  }

  if (timestamp === null || signature === null) {
    return null;
  }

  return { timestamp, signature };
}

/**
 * Verify the signature on a request from Arke
 */
export async function verifyArkeSignature(
  body: string,
  signatureHeader: string,
  apiBase: string
): Promise<VerifyResult> {
  // Parse header
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  const { timestamp, signature } = parsed;

  // Check timestamp freshness (5 min max age, 1 min future tolerance)
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 5 * 60; // 5 minutes
  const futureTolerance = 60; // 1 minute

  if (timestamp < now - maxAge) {
    return { valid: false, error: 'Signature timestamp too old' };
  }

  if (timestamp > now + futureTolerance) {
    return { valid: false, error: 'Signature timestamp in future' };
  }

  try {
    // Get public key
    const publicKey = await getArkePublicKey(apiBase);

    // Construct signed message: "{timestamp}.{body}"
    const message = `${timestamp}.${body}`;
    const messageBytes = new TextEncoder().encode(message);

    // Decode signature from hex
    const signatureBytes = hexToBytes(signature);

    // Verify
    const valid = await ed.verifyAsync(signatureBytes, messageBytes, publicKey);

    if (!valid) {
      return { valid: false, error: 'Signature verification failed' };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Verification error: ${err instanceof Error ? err.message : 'Unknown'}`,
    };
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
