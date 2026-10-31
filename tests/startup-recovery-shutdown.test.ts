import { describe, expect, it } from 'vitest';
import { createStartupRecoveryRetry } from '../packages/hub-core/src/integrations/bridge.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('startup recovery at shutdown', () => {
  it('the shutdown can wait for a recovery round that is running', async () => {
    let finish: () => void = () => undefined;
    const round = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let recovered = 0;
    const retry = createStartupRecoveryRetry({
      due: async () => false,
      recover: async () => {
        await round;
        recovered += 1;
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    void retry.attempt();
    // The shutdown stops the retry while the round is still running.
    retry.stop();
    let settled = false;
    void retry.settled().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    finish();
    await flush();
    expect(settled).toBe(true);
    expect(recovered).toBe(1);
  });

  it('the shutdown does not wait when no round is running', async () => {
    const retry = createStartupRecoveryRetry({
      due: async () => false,
      recover: async () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    retry.stop();
    await expect(retry.settled()).resolves.toBeUndefined();
  });
});
