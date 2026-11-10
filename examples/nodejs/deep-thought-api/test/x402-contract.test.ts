import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
    decodePaymentRequiredHeader,
    decodePaymentResponseHeader,
    encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
    PaymentPayload,
    SettleResponse,
    SupportedResponse,
    VerifyRequest,
    VerifyResponse,
} from "@x402/core/types";
import { createApp } from "../src/app";

const solanaNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const baseNetwork = "eip155:84532";
const solanaWallet = "11111111111111111111111111111111";
const baseWallet = "0x1111111111111111111111111111111111111111";
const solanaAsset = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const baseAsset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const supported: SupportedResponse = {
    kinds: [
        {
            x402Version: 2, scheme: "exact", network: solanaNetwork,
            extra: { asset: solanaAsset, name: "USDC", version: "2", decimals: 6, feePayer: solanaWallet },
        },
        {
            x402Version: 2, scheme: "exact", network: baseNetwork,
            extra: { asset: baseAsset, name: "USDC", version: "2", decimals: 6 },
        },
    ],
    extensions: [],
    signers: {},
};

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    })));
});

async function facilitator(options: { supportedFails?: boolean; approves?: boolean } = {}) {
    const calls: string[] = [];
    const verifications: VerifyRequest[] = [];
    const server = createServer(async (request, response) => {
        calls.push(`${request.method} ${request.url}`);
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" && request.url === "/supported") {
            response.statusCode = options.supportedFails ? 503 : 200;
            response.end(JSON.stringify(options.supportedFails ? { error: "unavailable" } : supported));
            return;
        }
        if (request.method === "POST" && request.url === "/verify") {
            let body = "";
            for await (const chunk of request) body += chunk;
            verifications.push(JSON.parse(body) as VerifyRequest);
            const result: VerifyResponse = options.approves
                ? { isValid: true, payer: baseWallet }
                : { isValid: false, invalidReason: "invalid_signature" };
            response.end(JSON.stringify(result));
            return;
        }
        if (request.method === "POST" && request.url === "/settle") {
            const result: SettleResponse = {
                success: true, transaction: "local-fixture-no-blockchain", network: baseNetwork, payer: baseWallet,
            };
            response.end(JSON.stringify(result));
            return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "unexpected facilitator request" }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, verifications };
}

describe("Deep Thought x402 contract (real SDK, loopback facilitator)", () => {
    it.each([
        { name: "EVM", wallets: { baseWalletAddress: baseWallet }, networks: [baseNetwork] },
        { name: "SVM", wallets: { solanaWalletAddress: solanaWallet }, networks: [solanaNetwork] },
        {
            name: "EVM and SVM", wallets: { baseWalletAddress: baseWallet, solanaWalletAddress: solanaWallet },
            networks: [solanaNetwork, baseNetwork],
        },
    ])("preserves free endpoints and v2 payment requirements for $name", async ({ wallets, networks }) => {
        const local = await facilitator();
        const app = await createApp({ ...wallets, facilitatorUrl: local.url });
        const root = await app.request("/");
        expect(root.status).toBe(200);
        expect(await root.json()).toMatchObject({ name: "Deep Thought API" });
        const health = await app.request("/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: "operational" });

        const response = await app.request("/answer");
        expect(response.status).toBe(402);
        const header = response.headers.get("PAYMENT-REQUIRED");
        expect(header).toBeTruthy();
        const required = decodePaymentRequiredHeader(header!);
        expect(required.x402Version).toBe(2);
        expect(required.resource).toMatchObject({ url: "http://localhost/answer", mimeType: "application/json" });
        expect(required.accepts.map(payment => payment.network)).toEqual(networks);
        for (const payment of required.accepts) {
            expect(payment).toMatchObject({
                scheme: "exact", amount: "1000", maxTimeoutSeconds: 300,
                asset: payment.network === baseNetwork ? baseAsset : solanaAsset,
                payTo: payment.network === baseNetwork ? baseWallet : solanaWallet,
                extra: payment.network === baseNetwork ? { name: "USDC", version: "2" } : { feePayer: solanaWallet },
            });
            if (payment.network === solanaNetwork) expect(payment.extra.feePayer).toBe(solanaWallet);
        }
        expect(local.calls.length).toBeGreaterThan(0);
        expect(local.calls.every(call => call === "GET /supported")).toBe(true);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.json()).toEqual({ error: "Payment required" });
    });

    it("rejects a malformed signature without reaching the handler or facilitator verification", async () => {
        const local = await facilitator();
        const app = await createApp({ baseWalletAddress: baseWallet, facilitatorUrl: local.url });
        const response = await app.request("/answer", { headers: { "PAYMENT-SIGNATURE": "not-a-payment" } });
        expect(response.status).toBe(402);
        expect(await response.json()).not.toHaveProperty("answer");
        expect(local.verifications).toHaveLength(0);
        expect(local.calls).not.toContain("POST /settle");
    });

    it("passes an invalid payment to local verification but never authorizes the handler", async () => {
        const local = await facilitator();
        const app = await createApp({ baseWalletAddress: baseWallet, facilitatorUrl: local.url });
        const challenge = await app.request("/answer");
        const required = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED")!);
        const payment: PaymentPayload = {
            x402Version: 2, resource: required.resource, accepted: required.accepts[0],
            payload: { signature: "0x00" },
        };
        const response = await app.request("/answer", {
            headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) },
        });
        expect(response.status).toBe(402);
        expect(await response.json()).not.toHaveProperty("answer");
        expect(local.verifications).toHaveLength(1);
        expect(local.verifications[0]).toMatchObject({ paymentPayload: payment, paymentRequirements: payment.accepted });
        expect(local.calls).not.toContain("POST /settle");
    });

    it("uses the real middleware to deliver and settle a locally authorized fixture", async () => {
        // The local facilitator authorizes this fixture; this does not test cryptographic validity.
        const local = await facilitator({ approves: true });
        const app = await createApp({ baseWalletAddress: baseWallet, facilitatorUrl: local.url });
        const challenge = await app.request("/answer");
        const required = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED")!);
        const payment: PaymentPayload = {
            x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { signature: "0x00" },
        };
        const response = await app.request("/answer", {
            headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ answer: 42, computer: "Deep Thought" });
        expect(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!)).toMatchObject({
            success: true, network: baseNetwork, transaction: "local-fixture-no-blockchain",
        });
        expect(local.calls.filter(call => call === "POST /verify")).toHaveLength(1);
        expect(local.calls.filter(call => call === "POST /settle")).toHaveLength(1);
    });

    it("keeps free routes available but fails closed on paid routes when supported fails", async () => {
        const local = await facilitator({ supportedFails: true });
        const app = await createApp({ baseWalletAddress: baseWallet, facilitatorUrl: local.url });
        const paid = await app.request("/answer");
        expect(paid.status).toBe(500);
        expect(paid.headers.get("content-type")).toBe("application/json");
        expect(await paid.json()).toEqual({ error: "Internal Server Error" });
        expect(paid.headers.has("PAYMENT-REQUIRED")).toBe(false);
        expect((await app.request("/")).status).toBe(200);
        expect((await app.request("/health")).status).toBe(200);
        expect(local.verifications).toHaveLength(0);
        expect(local.calls).not.toContain("POST /settle");
    });
});
