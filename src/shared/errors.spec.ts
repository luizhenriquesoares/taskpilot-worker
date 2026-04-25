import { describe, it, expect } from 'vitest';
import { PermanentError, isPermanentError, isLikelyTransient } from './errors.js';

describe('PermanentError', () => {
  it('preserves the message and sets isPermanent flag', () => {
    const err = new PermanentError('bad payload');
    expect(err.message).toBe('bad payload');
    expect(err.isPermanent).toBe(true);
    expect(err.name).toBe('PermanentError');
  });

  it('is an instance of Error so existing handlers still catch it', () => {
    expect(new PermanentError('x')).toBeInstanceOf(Error);
  });
});

describe('isPermanentError', () => {
  it('returns true for PermanentError instances', () => {
    expect(isPermanentError(new PermanentError('x'))).toBe(true);
  });

  it('returns true for plain objects with isPermanent: true', () => {
    expect(isPermanentError({ isPermanent: true, message: 'x' })).toBe(true);
  });

  it('returns false for ordinary errors', () => {
    expect(isPermanentError(new Error('whatever'))).toBe(false);
    expect(isPermanentError(new TypeError('nope'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isPermanentError(null)).toBe(false);
    expect(isPermanentError(undefined)).toBe(false);
    expect(isPermanentError('string')).toBe(false);
    expect(isPermanentError(42)).toBe(false);
    expect(isPermanentError({})).toBe(false);
  });
});

describe('isLikelyTransient', () => {
  it('classifies common Node networking errno codes as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']) {
      const err = Object.assign(new Error('x'), { code });
      expect(isLikelyTransient(err)).toBe(true);
    }
  });

  it('classifies timeout / rate-limit / 5xx messages as transient', () => {
    expect(isLikelyTransient(new Error('Operation timed out'))).toBe(true);
    expect(isLikelyTransient(new Error('rate limit exceeded'))).toBe(true);
    expect(isLikelyTransient(new Error('upstream returned 503'))).toBe(true);
    expect(isLikelyTransient(new Error('Service Unavailable'))).toBe(true);
    expect(isLikelyTransient(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT classify generic application errors as transient', () => {
    expect(isLikelyTransient(new Error('card not found'))).toBe(false);
    expect(isLikelyTransient(new Error('invalid payload'))).toBe(false);
    expect(isLikelyTransient(new Error('PR has merge conflicts'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isLikelyTransient(null)).toBe(false);
    expect(isLikelyTransient('timeout')).toBe(false); // string, not Error
    expect(isLikelyTransient({ message: 'timeout' })).toBe(false); // plain object
  });
});
