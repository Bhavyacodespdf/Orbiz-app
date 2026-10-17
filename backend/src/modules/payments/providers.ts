import type { Env } from '../../config/env.js';
import { randomToken } from '../../lib/crypto.js';
import type { PaymentProvider } from '../../generated/prisma/enums.js';

/**
 * What a payment provider must do for CampusCart. The wallet's business rules
 * (limits, ledger, idempotent credit) live in the wallet service and do not
 * change when a provider is swapped.
 *
 * Adding a real provider later means:
 *   1. an adapter implementing this interface (create the provider-side order),
 *   2. a webhook route that verifies the provider's signature and then calls
 *      settleRecharge() with the VERIFIED outcome — never a browser redirect.
 */
export interface RechargeProvider {
  readonly name: PaymentProvider;
  /** True when no real money moves. The mock is always simulated. */
  readonly isSimulated: boolean;
  /** Called before the attempt is stored. Returns the provider's reference and what the browser should do next. */
  prepareRecharge(params: { amountPaise: number }): Promise<{
    providerReference: string;
    nextAction: { type: 'MOCK_SIMULATOR' };
  }>;
}

/**
 * Development/test-only simulator. It never contacts a bank, UPI or card
 * network. The outcome (success / failure / cancel) is chosen in the clearly
 * labelled simulator panel and applied by settleRecharge().
 */
export const mockRechargeProvider: RechargeProvider = {
  name: 'MOCK',
  isSimulated: true,
  async prepareRecharge() {
    return { providerReference: `mock_${randomToken(16)}`, nextAction: { type: 'MOCK_SIMULATOR' } };
  },
};

/**
 * The provider for wallet recharges in this environment, or null when none is
 * configured. Mock mode is impossible in production (env validation refuses to
 * start), and this check is repeated here so mock can never be selected silently.
 */
export function rechargeProviderFor(config: Env): RechargeProvider | null {
  if (config.PAYMENT_MOCK_ENABLED && config.NODE_ENV !== 'production') return mockRechargeProvider;
  return null;
}
