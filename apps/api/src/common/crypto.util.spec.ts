import {
  decrypt, encrypt, hashPassword, signWebhook, verifyPassword, verifyWebhookSignature,
} from './crypto.util';

const KEY = 'ab'.repeat(32);
const SECRET = 'whsec_test';
const BODY = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' });

describe('webhook signature verification', () => {
  const now = 1_700_000_000;

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyWebhookSignature(BODY, signWebhook(BODY, SECRET, now), SECRET, { now })).toBe(true);
  });
  it('rejects a tampered body', () => {
    const sig = signWebhook(BODY, SECRET, now);
    expect(verifyWebhookSignature(BODY.replace('succeeded', 'failed'), sig, SECRET, { now })).toBe(false);
  });
  it('rejects the wrong secret', () => {
    expect(verifyWebhookSignature(BODY, signWebhook(BODY, 'other', now), SECRET, { now })).toBe(false);
  });
  it('rejects stale timestamps (replay protection)', () => {
    const sig = signWebhook(BODY, SECRET, now - 301);
    expect(verifyWebhookSignature(BODY, sig, SECRET, { now })).toBe(false);
  });
  it('rejects missing or malformed headers without throwing', () => {
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, 'garbage', SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, `t=${now},v1=zz`, SECRET, { now })).toBe(false);
    expect(verifyWebhookSignature(BODY, `t=${now},v1=abcd`, SECRET, { now })).toBe(false);
  });
});

describe('credential encryption', () => {
  it('round-trips', () => expect(decrypt(encrypt('secret-value', KEY), KEY)).toBe('secret-value'));
  it('uses a fresh IV each time', () => expect(encrypt('x', KEY)).not.toBe(encrypt('x', KEY)));
  it('detects tampering (GCM auth tag)', () => {
    const [iv, tag, ct] = encrypt('secret-value', KEY).split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64')].join('.'), KEY)).toThrow();
  });
  it('rejects a wrong-length key', () => expect(() => encrypt('x', 'abcd')).toThrow());
});

describe('password hashing', () => {
  it('verifies correct and rejects wrong passwords', async () => {
    const h = await hashPassword('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('salts: same password yields different hashes', async () => {
    expect(await hashPassword('Same-Password-1')).not.toBe(await hashPassword('Same-Password-1'));
  });
  it('rejects malformed stored hashes', async () => expect(await verifyPassword('x', 'plaintext')).toBe(false));
});
