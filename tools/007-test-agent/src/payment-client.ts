import { x402Client } from '@x402/fetch';
import type { NetworkConfig } from './cli.js';

export function createPaymentClient(network: NetworkConfig): x402Client {
    const { chainId, asset } = network;
    return new x402Client()
        .setSpendControls({
            allowedAssets: [{ network: chainId, asset }],
            // The CLI historically has no amount cap; mainnet approval remains in its before hook.
            maxAmountPerPayment: false,
        })
        .registerPolicy((_version, requirements) => {
            // SDK defaults remain allowed by spend controls, so enforce the CLI's exact asset too.
            const matching = requirements.filter(requirement =>
                requirement.network === chainId && requirement.asset.toLowerCase() === asset.toLowerCase());
            if (matching.length === 0) {
                throw new Error(`NETWORK/ASSET MISMATCH: Expected '${chainId}' and asset '${asset}'.`);
            }
            return matching;
        });
}
