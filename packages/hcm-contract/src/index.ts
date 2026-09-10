export * from './domain.js';
export * from './resources.js';
export * from './requests.js';

/**
 * Version of this contract.
 *
 * Bumped when the shape changes in a way a client must notice. The mock server
 * echoes it in a response header so a client can detect drift rather than
 * discover it through a parse failure.
 */
export const HCM_CONTRACT_VERSION = '1.0.0';

/** Base path the API is mounted at, matching typical HCM REST conventions. */
export const HCM_API_BASE_PATH = '/hcm/api/v1';
