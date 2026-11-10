import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
    wrapFetchWithPayment,
    x402Client,
    x402HTTPClient,
    type PaymentPayload,
    type PaymentRequirements,
} from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { createKeyPairSignerFromBytes, createSignableMessage } from '@solana/signers';
import { base58 } from '@scure/base';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { getNetworkConfig } from '../src/cli.js';
import { target, requirements, challenge, unpaid, forbidExternalFetch } from './fixtures/payment-sdk.js';

afterEach(() => vi.unstubAllGlobals());

describe('real x402 SDK contracts (no CLI entrypoint, RPC or settlement)', () => {
    it('registers the real EVM account and preserves POST body/headers through the paid retry', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const account = privateKeyToAccount(generatePrivateKey());
        const client = new x402Client();
        expectTypeOf(registerExactEvmScheme(client, {
            signer: account,
            networks: [getNetworkConfig('base').chainId],
        })).toEqualTypeOf<x402Client>();

        const selected = requirements();
        const paymentRequired = challenge(selected);
        const events: string[] = [];
        let created: PaymentPayload | undefined;
        expect(client.onBeforePaymentCreation(async context => {
            expectTypeOf(context.selectedRequirements).toEqualTypeOf<PaymentRequirements>();
            expect(context.paymentRequired).toEqual(paymentRequired);
            expect(context.selectedRequirements).toEqual(selected);
            events.push('before');
        })).toBe(client);
        expect(client.onAfterPaymentCreation(async context => {
            expectTypeOf(context.paymentPayload).toEqualTypeOf<PaymentPayload>();
            created = context.paymentPayload;
            events.push('after');
        })).toBe(client);

        const requests: Request[] = [];
        const transport: typeof fetch = async (input, init) => {
            const request = new Request(input, init);
            requests.push(request.clone());
            events.push(`request-${requests.length}`);
            return requests.length === 1 ? unpaid(paymentRequired) : Response.json({ granted: true });
        };
        const body = JSON.stringify({ prompt: 'offline' });
        const response = await wrapFetchWithPayment(transport, client)(target, {
            method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Contract': 'preserved' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ granted: true });
        expect(events).toEqual(['request-1', 'before', 'after', 'request-2']);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.url).toBe(target);
            expect(request.method).toBe('POST');
            expect(request.headers.get('content-type')).toBe('application/json');
            expect(request.headers.get('x-contract')).toBe('preserved');
            expect(await request.text()).toBe(body);
        }
        expect(requests[0].headers.has('PAYMENT-SIGNATURE')).toBe(false);
        expect(created?.accepted).toEqual(selected);
        expect(created?.x402Version).toBe(2);
        const encoded = new x402HTTPClient(client).encodePaymentSignatureHeader(created!);
        expect(requests[1].headers.get('PAYMENT-SIGNATURE')).toBe(encoded['PAYMENT-SIGNATURE']);
        expect(requests[1].headers.get('PAYMENT-SIGNATURE')).toBeTruthy();

        // Verify the SDK's EIP-3009 signature locally, not through a facilitator or RPC.
        const payload = created!.payload as {
            signature: `0x${string}`;
            authorization: {
                from: `0x${string}`; to: `0x${string}`; value: string;
                validAfter: string; validBefore: string; nonce: `0x${string}`;
            };
        };
        expect(payload.authorization.from).toBe(account.address);
        expect(payload.authorization.to).toBe(selected.payTo);
        expect(payload.authorization.value).toBe(selected.amount);
        expect(await verifyTypedData({
            address: account.address,
            domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: selected.asset as `0x${string}` },
            types: { TransferWithAuthorization: [
                { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
            ] },
            primaryType: 'TransferWithAuthorization',
            message: {
                ...payload.authorization, value: BigInt(payload.authorization.value),
                validAfter: BigInt(payload.authorization.validAfter),
                validBefore: BigInt(payload.authorization.validBefore),
            },
            signature: payload.signature,
        })).toBe(true);
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('returns a free response without invoking payment hooks or retrying', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const client = new x402Client();
        const before = vi.fn(async () => {});
        client.onBeforePaymentCreation(before);
        const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ free: true }));
        const response = await wrapFetchWithPayment(transport, client)(target);
        expect(await response.json()).toEqual({ free: true });
        expect(transport).toHaveBeenCalledTimes(1);
        expect(before).not.toHaveBeenCalled();
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('rejects an unregistered network before signing or invoking creation hooks', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const client = new x402Client();
        registerExactEvmScheme(client, {
            signer: privateKeyToAccount(generatePrivateKey()),
            networks: [getNetworkConfig('base').chainId],
        });
        const before = vi.fn(async () => {});
        client.onBeforePaymentCreation(before);
        const selected = { ...requirements(), network: getNetworkConfig('base-mainnet').chainId };
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/network\/scheme|registered/i);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(before).not.toHaveBeenCalled();
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('rejects a non-default asset through SDK spend controls before hooks or retry', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const client = new x402Client();
        registerExactEvmScheme(client, {
            signer: privateKeyToAccount(generatePrivateKey()),
            networks: [getNetworkConfig('base').chainId],
        });
        const before = vi.fn(async () => {});
        const after = vi.fn(async () => {});
        client.onBeforePaymentCreation(before).onAfterPaymentCreation(after);
        const selected = { ...requirements(), asset: privateKeyToAccount(generatePrivateKey()).address };
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/rejected by spendControls/);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(before).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('decodes disposable Solana key bytes and registers the real signer without RPC', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
        const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
        const keyBytes = new Uint8Array([...Buffer.from(privateJwk.d!, 'base64url'), ...publicBytes]);
        const signer = await createKeyPairSignerFromBytes(base58.decode(base58.encode(keyBytes)));
        expect(signer.address).toBe(base58.encode(publicBytes));
        const message = createSignableMessage('Offline local signer contract');
        const [signatures] = await signer.signMessages([message]);
        expect(await crypto.subtle.verify('Ed25519', keyPair.publicKey,
            new Uint8Array(signatures[signer.address]), new Uint8Array(message.content))).toBe(true);
        const client = new x402Client();
        const registered = registerExactSvmScheme(client, {
            signer, networks: [getNetworkConfig('solana').chainId],
        });
        expectTypeOf(registered).toEqualTypeOf<x402Client>();
        expect(registered).toBe(client);
        let selected: PaymentRequirements | undefined;
        client.onBeforePaymentCreation(async context => {
            selected = context.selectedRequirements;
            return { abort: true, reason: 'Offline contract: never build or send an SVM transaction' };
        });
        const paymentRequired = challenge(requirements('solana'));
        const transport = vi.fn<typeof fetch>().mockResolvedValue(unpaid(paymentRequired));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/Offline contract/);
        expect(selected).toEqual(paymentRequired.accepts[0]);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('does not endlessly retry a second 402 response', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const client = new x402Client();
        registerExactEvmScheme(client, {
            signer: privateKeyToAccount(generatePrivateKey()),
            networks: [getNetworkConfig('base').chainId],
        });
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid());
        const response = await wrapFetchWithPayment(transport, client)(target);
        expect(response.status).toBe(402);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('rejects a malformed 402 instead of signing or retrying', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const client = new x402Client();
        const before = vi.fn(async () => {});
        client.onBeforePaymentCreation(before);
        const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 402 }));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/parse payment requirements/);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(before).not.toHaveBeenCalled();
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('parses a synthetic settlement header using SDK helpers without settling anything', () => {
        const unexpectedFetch = forbidExternalFetch();
        const settlement = {
            success: true, transaction: 'offline-fixture-not-a-chain-transaction',
            network: getNetworkConfig('base').chainId,
        };
        const headers = new Headers({ 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement) });
        const httpClient = new x402HTTPClient(new x402Client());
        expect(httpClient.getPaymentSettleResponse(name => headers.get(name))).toEqual(settlement);
        expect(() => httpClient.getPaymentSettleResponse(() => null)).toThrow();
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });
});
