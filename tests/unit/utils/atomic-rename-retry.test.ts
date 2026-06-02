import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  copyFileSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);
vi.mock('crypto', () => ({
  randomBytes: () => Buffer.from('abcdef123456', 'hex'),
}));

import { atomicWriteSync } from '../../../src/utils/atomic';

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('atomicWriteSync rename retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
  });

  it('retries transient Windows rename failures before succeeding', () => {
    fsMocks.renameSync
      .mockImplementationOnce(() => { throw errno('EPERM'); })
      .mockImplementationOnce(() => { throw errno('EBUSY'); })
      .mockImplementationOnce(() => undefined);

    atomicWriteSync('C:\\tmp\\crons.json', '{"ok":true}');

    expect(fsMocks.renameSync).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-transient rename failures', () => {
    fsMocks.renameSync.mockImplementationOnce(() => { throw errno('EXDEV'); });

    expect(() => atomicWriteSync('C:\\tmp\\crons.json', '{"ok":true}')).toThrow('EXDEV');
    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);
  });
});
