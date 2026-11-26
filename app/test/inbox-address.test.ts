import { describe, expect, it } from 'vitest';
import { inboxCode } from '../src/enclave';

describe('inboxCode', () => {
  it('reads the code from both address styles', () => {
    expect(inboxCode('abcde23456@inbox.example.test')).toBe('abcde23456');
    expect(inboxCode('notch-inbox+abcde23456@agentmail.to')).toBe('abcde23456');
  });
});
