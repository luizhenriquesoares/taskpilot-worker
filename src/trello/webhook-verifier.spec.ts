import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { verifyTrelloWebhookSignature } from './webhook-verifier.js';

function sign(body: string, callbackUrl: string, secret: string): string {
  return crypto.createHmac('sha1', secret).update(body + callbackUrl).digest('base64');
}

describe('verifyTrelloWebhookSignature', () => {
  const secret = 'top-secret-trello-app-secret';
  const callbackUrl = 'https://taskpilot.maismilhas.com.br/webhook';
  const body = '{"action":{"type":"updateCard","data":{"card":{"id":"abc"}}}}';

  it('accepts a correctly signed request', () => {
    const sig = sign(body, callbackUrl, secret);
    expect(verifyTrelloWebhookSignature(body, callbackUrl, secret, sig)).toBe(true);
  });

  it('rejects when the body bytes differ', () => {
    const sig = sign(body, callbackUrl, secret);
    const tampered = body.replace('abc', 'xyz');
    expect(verifyTrelloWebhookSignature(tampered, callbackUrl, secret, sig)).toBe(false);
  });

  it('rejects when the callback URL differs', () => {
    const sig = sign(body, callbackUrl, secret);
    expect(verifyTrelloWebhookSignature(body, 'https://attacker.example/webhook', secret, sig)).toBe(false);
  });

  it('rejects when the secret differs', () => {
    const sig = sign(body, callbackUrl, secret);
    expect(verifyTrelloWebhookSignature(body, callbackUrl, 'wrong-secret', sig)).toBe(false);
  });

  it('rejects when the signature header is empty', () => {
    expect(verifyTrelloWebhookSignature(body, callbackUrl, secret, '')).toBe(false);
  });

  it('rejects when the signature length differs (avoids timing leak path)', () => {
    expect(verifyTrelloWebhookSignature(body, callbackUrl, secret, 'tooShort')).toBe(false);
  });

  it('rejects whitespace-only differences in body (raw bytes matter)', () => {
    // Trello signs the EXACT bytes; re-serializing JSON would trip this.
    const sig = sign(body, callbackUrl, secret);
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(reformatted).not.toBe(body);
    expect(verifyTrelloWebhookSignature(reformatted, callbackUrl, secret, sig)).toBe(false);
  });
});
