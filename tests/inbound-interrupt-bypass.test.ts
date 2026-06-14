import { describe, it, expect } from 'vitest';
import { planInboundCycle } from '../src/daemon/fast-checker.js';

/**
 * Interrupt-bypass policy: user-direct Telegram messages (already past the ALLOWED_USER gate)
 * jump the active-turn hold so the user never waits a full turn. Agent-to-agent (inbox) and
 * crons stay held while the agent is mid-turn, and are never injected alongside a user
 * interrupt (Telegram-only when proceeding mid-turn).
 */
describe('planInboundCycle (interrupt-bypass)', () => {
  it('idle agent injects everything (telegram + inbox)', () => {
    expect(planInboundCycle(false, 1, 0)).toEqual({ hold: false, injectInbox: true });
    expect(planInboundCycle(false, 0, 1)).toEqual({ hold: false, injectInbox: true });
    expect(planInboundCycle(false, 2, 3)).toEqual({ hold: false, injectInbox: true });
    expect(planInboundCycle(false, 0, 0)).toEqual({ hold: false, injectInbox: true });
  });

  it('active agent: a user Telegram message BYPASSES the hold (no wait for the user)', () => {
    expect(planInboundCycle(true, 1, 0)).toEqual({ hold: false, injectInbox: false });
  });

  it('active agent: Telegram interrupt injects telegram ONLY, inbox stays queued', () => {
    // telegram + inbox both pending mid-turn → proceed (no hold), but injectInbox=false
    expect(planInboundCycle(true, 1, 5)).toEqual({ hold: false, injectInbox: false });
  });

  it('active agent: background-only (inbox/cron) traffic is HELD until the turn ends', () => {
    expect(planInboundCycle(true, 0, 1)).toEqual({ hold: true, injectInbox: false });
    expect(planInboundCycle(true, 0, 9)).toEqual({ hold: true, injectInbox: false });
  });

  it('active agent with nothing pending is a no-op (no hold, nothing to inject)', () => {
    expect(planInboundCycle(true, 0, 0)).toEqual({ hold: false, injectInbox: false });
  });

  it('the user is NEVER held: any telegram>0 yields hold=false regardless of activity/inbox', () => {
    for (const active of [true, false]) {
      for (const inbox of [0, 1, 50]) {
        expect(planInboundCycle(active, 1, inbox).hold).toBe(false);
      }
    }
  });

  it('inbox is never injected mid-turn (injectInbox true only when idle)', () => {
    for (const tg of [0, 1, 5]) {
      for (const inbox of [0, 1, 5]) {
        expect(planInboundCycle(true, tg, inbox).injectInbox).toBe(false);
      }
    }
  });
});
