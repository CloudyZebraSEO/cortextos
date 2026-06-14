import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ESCALATE_AFTER_MS, TelegramPoller } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw,
    // and should still report that an update was received (boolean return).
    await expect(poller.pollOnce()).resolves.toBe(true);

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? readFileSync(f, 'utf-8').trim() : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });
});

describe('TelegramPoller — self-healing loop', () => {
  let stateDir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-selfheal-'));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('backs off, rate-limits stack logging, and exits poll-stuck after sustained fetch failure', async () => {
    const api = {
      getUpdates: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);

    const started = poller.start();
    await vi.advanceTimersByTimeAsync(ESCALATE_AFTER_MS + 60_000);
    await started;

    expect(poller.lastExitReason).toBe('poll-stuck');
    expect(api.getUpdates).toHaveBeenCalled();
    const fullErrorLines = errorSpy.mock.calls.filter((call) => String(call[0]).includes('Poll error'));
    const summaryLines = errorSpy.mock.calls.filter((call) => String(call[0]).includes('poll still failing'));
    expect(fullErrorLines).toHaveLength(1);
    expect(summaryLines.length).toBeLessThanOrEqual(1);
  });

  it('fires onApiSuccess, logs recovery, and resets failure counters after a transient failure', async () => {
    const api = {
      getUpdates: vi
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue({ result: [] }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);
    const onApiSuccess = vi.fn(() => poller.stop());
    poller.onApiSuccess = onApiSuccess;

    const started = poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await started;

    expect(onApiSuccess).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('recovered after 1 failure'))).toBe(true);
    expect(poller.lastExitReason).toBe('stopped-externally');
  });

  it('exits auth-failed on permanent Telegram token errors', async () => {
    const api = {
      getUpdates: vi.fn(async () => {
        throw new Error('Telegram API error: Unauthorized');
      }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);

    await poller.start();

    expect(poller.lastExitReason).toBe('auth-failed');
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('preserves conflict self-die behavior', async () => {
    const api = {
      getUpdates: vi.fn(async () => {
        throw new Error('Telegram API error: Conflict: terminated by other getUpdates request');
      }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);

    await poller.start();

    expect(poller.lastExitReason).toBe('conflict-self-die');
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('marks API success before handler dispatch, so handler failures do not hide reachability', async () => {
    const { api } = makeStubApi([makeMessageUpdate(700, 'handler fails')]);
    const poller = new TelegramPoller(api, stateDir);
    const onApiSuccess = vi.fn();
    poller.onApiSuccess = onApiSuccess;
    poller.onMessage(() => {
      throw new Error('handler failed');
    });

    await poller.pollOnce();

    expect(onApiSuccess).toHaveBeenCalledTimes(1);
    const offsetFile = join(stateDir, '.telegram-offset');
    expect(existsSync(offsetFile)).toBe(false);
  });
});

describe('TelegramPoller — stopAndWait (poller-dedup teardown)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-stop-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('aborts an in-flight getUpdates and resolves with stopped-externally', async () => {
    let abortReceived = false;
    const api = {
      // Long-poll that never resolves on its own — only an abort ends it.
      getUpdates: vi.fn((_offset: number, _limit: number, _timeout: number, signal?: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              abortReceived = true;
              reject(new Error('Telegram API request timed out after 30000ms: getUpdates'));
            });
          }
        });
      }),
    } as unknown as TelegramAPI;

    const poller = new TelegramPoller(api, stateDir);
    const startP = poller.start();
    // Let the loop enter the in-flight getUpdates before stopping.
    await new Promise((r) => setTimeout(r, 20));

    await poller.stopAndWait();
    await startP; // start() must have fully exited

    expect(abortReceived).toBe(true);
    expect(poller.lastExitReason).toBe('stopped-externally');
  });

  it('resolves cleanly when the poller was never started', async () => {
    const { api } = makeStubApi([]);
    const poller = new TelegramPoller(api, stateDir);
    await expect(poller.stopAndWait()).resolves.toBeUndefined();
    expect(poller.lastExitReason).toBe('stopped-externally');
  });
});
