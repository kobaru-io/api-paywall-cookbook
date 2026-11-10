import { afterEach, describe, expect, it, vi } from 'vitest';
import { wrapFetchWithPayment, type PaymentPayload } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { getNetworkConfig } from '../src/cli.js';
import { createPaymentClient } from '../src/payment-client.js';
import { target, requirements, challenge, unpaid, forbidExternalFetch } from './fixtures/payment-sdk.js';

afterEach(() => vi.unstubAllGlobals());

describe('production payment client contracts (no CLI entrypoint, RPC or settlement)', () => {
    it.each(['base', 'base-mainnet', 'skale', 'skale-mainnet'] as const)(
        'production client permits the configured %s asset above one dollar and signs locally', async network => {
            const unexpectedFetch = forbidExternalFetch();
            const config = getNetworkConfig(network);
            const client = createPaymentClient(config);
            const account = privateKeyToAccount(generatePrivateKey());
            registerExactEvmScheme(client, { signer: account, networks: [config.chainId] });
            const selected = { ...requirements(network), amount: '2000000' };
            const before = vi.fn(async () => {});
            let created: PaymentPayload | undefined;
            client.onBeforePaymentCreation(before).onAfterPaymentCreation(async context => {
                created = context.paymentPayload;
            });
            const transport = vi.fn<typeof fetch>()
                .mockImplementationOnce(async () => unpaid(challenge(selected)))
                .mockImplementationOnce(async () => Response.json({ granted: true }));
            const response = await wrapFetchWithPayment(transport, client)(target);
            expect(response.status).toBe(200);
            expect(before).toHaveBeenCalledTimes(1);
            expect(created?.accepted).toEqual(selected);
            const payload = created!.payload as {
                signature: `0x${string}`;
                authorization: {
                    from: `0x${string}`; to: `0x${string}`; value: string;
                    validAfter: string; validBefore: string; nonce: `0x${string}`;
                };
            };
            expect(await verifyTypedData({
                address: account.address,
                domain: { name: 'USDC', version: '2', chainId: Number(config.chainId.split(':')[1]),
                    verifyingContract: config.asset as `0x${string}` },
                types: { TransferWithAuthorization: [
                    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
                ] },
                primaryType: 'TransferWithAuthorization',
                message: { ...payload.authorization, value: BigInt(payload.authorization.value),
                    validAfter: BigInt(payload.authorization.validAfter), validBefore: BigInt(payload.authorization.validBefore) },
                signature: payload.signature,
            })).toBe(true);
            expect(transport).toHaveBeenCalledTimes(2);
            expect(unexpectedFetch).not.toHaveBeenCalled();
        },
    );

    it.each(['solana', 'solana-mainnet'] as const)(
        'production client permits the configured %s asset above one dollar up to the pre-RPC hook', async network => {
            const unexpectedFetch = forbidExternalFetch();
            const config = getNetworkConfig(network);
            const client = createPaymentClient(config);
            const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
            const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
            const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
            const signer = await createKeyPairSignerFromBytes(new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...publicBytes]));
            registerExactSvmScheme(client, { signer, networks: [config.chainId] });
            const selected = { ...requirements(network), amount: '2000000' };
            const before = vi.fn(async () => ({ abort: true as const, reason: 'Offline: reached confirmation boundary before RPC' }));
            client.onBeforePaymentCreation(before);
            const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
            await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow('reached confirmation boundary');
            expect(before).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ selectedRequirements: selected }));
            expect(transport).toHaveBeenCalledTimes(1);
            expect(unexpectedFetch).not.toHaveBeenCalled();
        },
    );

    it.each(['base', 'base-mainnet', 'skale', 'skale-mainnet'] as const)(
        'production %s client rejects a different asset before hooks/signing', async network => {
            const unexpectedFetch = forbidExternalFetch();
            const config = getNetworkConfig(network);
            const client = createPaymentClient(config);
            const account = privateKeyToAccount(generatePrivateKey());
            const signTypedData = vi.fn(account.signTypedData);
            registerExactEvmScheme(client, { signer: { ...account, signTypedData }, networks: [config.chainId] });
            const before = vi.fn(async () => {});
            client.onBeforePaymentCreation(before);
            const selected = { ...requirements(network), asset: privateKeyToAccount(generatePrivateKey()).address };
            const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
            await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/spendControls|ASSET MISMATCH|policies/);
            expect(before).not.toHaveBeenCalled();
            expect(signTypedData).not.toHaveBeenCalled();
            expect(transport).toHaveBeenCalledTimes(1);
            expect(unexpectedFetch).not.toHaveBeenCalled();
        },
    );

    it('production client rejects an SDK default asset when it differs from configured asset', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const config = { ...getNetworkConfig('base-mainnet'), asset: privateKeyToAccount(generatePrivateKey()).address };
        const client = createPaymentClient(config);
        const account = privateKeyToAccount(generatePrivateKey());
        const signTypedData = vi.fn(account.signTypedData);
        registerExactEvmScheme(client, { signer: { ...account, signTypedData }, networks: [config.chainId] });
        const before = vi.fn(async () => {});
        client.onBeforePaymentCreation(before);
        const selected = requirements('base-mainnet');
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/ASSET MISMATCH/);
        expect(before).not.toHaveBeenCalled();
        expect(signTypedData).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledTimes(1);
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('production policy rejects a different network even if another scheme is registered', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const client = createPaymentClient(getNetworkConfig('base'));
        const account = privateKeyToAccount(generatePrivateKey());
        const signTypedData = vi.fn(account.signTypedData);
        registerExactEvmScheme(client, { signer: { ...account, signTypedData },
            networks: [getNetworkConfig('base').chainId, getNetworkConfig('base-mainnet').chainId] });
        const before = vi.fn(async () => {});
        client.onBeforePaymentCreation(before);
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(requirements('base-mainnet'))));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow('NETWORK/ASSET MISMATCH');
        expect(before).not.toHaveBeenCalled();
        expect(signTypedData).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledTimes(1);
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it('production policy preserves the existing case-insensitive EVM asset comparison', async () => {
        const unexpectedFetch = forbidExternalFetch();
        const config = getNetworkConfig('base');
        const client = createPaymentClient(config);
        registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()), networks: [config.chainId] });
        const before = vi.fn(async () => ({ abort: true as const, reason: 'Offline case match' }));
        client.onBeforePaymentCreation(before);
        const selected = { ...requirements(), asset: config.asset.toLowerCase() };
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
        await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow('Offline case match');
        expect(before).toHaveBeenCalledTimes(1);
        expect(unexpectedFetch).not.toHaveBeenCalled();
    });

    it.each(['solana', 'solana-mainnet'] as const)(
        'production %s client rejects another asset before reaching the RPC boundary', async network => {
            const unexpectedFetch = forbidExternalFetch();
            const config = getNetworkConfig(network);
            const client = createPaymentClient(config);
            const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
            const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
            const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
            const signer = await createKeyPairSignerFromBytes(new Uint8Array([...Buffer.from(jwk.d!, 'base64url'), ...publicBytes]));
            registerExactSvmScheme(client, { signer, networks: [config.chainId] });
            const before = vi.fn(async () => ({ abort: true as const, reason: 'Should not reach creation' }));
            client.onBeforePaymentCreation(before);
            const selected = { ...requirements(network), asset: signer.address };
            const transport = vi.fn<typeof fetch>().mockImplementation(async () => unpaid(challenge(selected)));
            await expect(wrapFetchWithPayment(transport, client)(target)).rejects.toThrow(/spendControls|ASSET MISMATCH/);
            expect(before).not.toHaveBeenCalled();
            expect(transport).toHaveBeenCalledTimes(1);
            expect(unexpectedFetch).not.toHaveBeenCalled();
        },
    );
});
