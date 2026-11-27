import { describe, expect, it } from 'vitest';
import { RETURN_URL, returnPath } from '../src/native';

describe('Android app: the link Phantom answers to', () => {
  it('carries Phantom’s answer and the screen back into the app', () => {
    expect(returnPath(`${RETURN_URL}?phantom=tx&nonce=abc&data=def#borrow`)).toBe('/?phantom=tx&nonce=abc&data=def#borrow');
  });
  it('drops anything Phantom does not send', () => {
    expect(returnPath(`${RETURN_URL}?phantom=connect&redirect=https%3A%2F%2Fexample.com#//example.com`)).toBe('/?phantom=connect');
  });
  it('ignores other links', () => {
    expect(returnPath('https://example.com/?phantom=tx')).toBeNull();
    expect(returnPath(`${RETURN_URL}?nonce=abc`)).toBeNull();
  });
});
