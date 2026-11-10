import { vi } from 'vitest';
import type { PaymentRequired, PaymentRequirements } from '@x402/fetch';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getNetworkConfig, type NetworkOption } from '../../src/cli.js';

export const target = 'http://127.0.0.1:40200/contract';

export function requirements(network: NetworkOption = 'base'): PaymentRequirements {
    const config = getNetworkConfig(network);
    return {
        scheme: 'exact',
        network: config.chainId,
        asset: config.asset,
        amount: '1000',
        payTo: config.type === 'evm'
            ? privateKeyToAccount(generatePrivateKey()).address
            : '11111111111111111111111111111111',
        maxTimeoutSeconds: 60,
        extra: config.type === 'evm' ? { name: 'USDC', version: '2' } : {},
    };
}

export function challenge(selected = requirements()): PaymentRequired {
    return {
        x402Version: 2,
        resource: { url: target, description: 'Offline contract fixture', mimeType: 'application/json' },
        accepts: [selected],
    };
}

export function unpaid(paymentRequired = challenge()): Response {
    // Typed protocol fixtures are consumed by the SDK; no hand-encoded payment headers.
    return Response.json({}, {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired) },
    });
}

export function forbidExternalFetch() {
    const unexpectedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected RPC/network access'));
    vi.stubGlobal('fetch', unexpectedFetch);
    return unexpectedFetch;
}
