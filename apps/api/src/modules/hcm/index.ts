/** HCM client factory. */

import { getConfig, type AppConfig } from '../../config/index.js';
import { HttpHcmClient } from './http-client.js';
import { HcmClientError, type HcmClient } from './types.js';

export * from './types.js';
export { HttpHcmClient } from './http-client.js';

/**
 * Used when no HCM is configured.
 *
 * Reports itself as unconfigured so the assistant simply omits the leave tools
 * rather than offering capabilities it cannot deliver - a model that offers to
 * book leave and then fails is worse than one that never offered.
 */
export class UnconfiguredHcmClient implements HcmClient {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async ping(): Promise<boolean> {
    return false;
  }

  private fail(): never {
    throw new HcmClientError(
      'CONFIGURATION_ERROR',
      'No HCM system is configured. Set HCM_BASE_URL to enable leave management.',
      503,
    );
  }

  async getEmployee(): Promise<never> {
    this.fail();
  }
  async listLeaveTypes(): Promise<never> {
    this.fail();
  }
  async getLeaveBalances(): Promise<never> {
    this.fail();
  }
  async getLeaveBalance(): Promise<never> {
    this.fail();
  }
  async getLeaveHistory(): Promise<never> {
    this.fail();
  }
  async getLeaveRequest(): Promise<never> {
    this.fail();
  }
  async validateLeaveRequest(): Promise<never> {
    this.fail();
  }
  async applyForLeave(): Promise<never> {
    this.fail();
  }
  async withdrawLeaveRequest(): Promise<never> {
    this.fail();
  }
  async cancelLeaveRequest(): Promise<never> {
    this.fail();
  }
}

let cached: HcmClient | null = null;

export function createHcmClient(config: AppConfig = getConfig()): HcmClient {
  if (!config.hcm.baseUrl) return new UnconfiguredHcmClient();

  return new HttpHcmClient({
    baseUrl: config.hcm.baseUrl,
    apiKey: config.hcm.apiKey,
    timeoutMs: config.hcm.requestTimeoutMs,
    retryLimit: config.hcm.retryLimit,
  });
}

export function getHcmClient(): HcmClient {
  cached ??= createHcmClient();
  return cached;
}

export function setHcmClient(client: HcmClient | null): void {
  cached = client;
}
