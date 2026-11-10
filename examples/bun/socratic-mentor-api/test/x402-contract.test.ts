import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyRequest, VerifyResponse } from "@x402/core/types";
import type { createApp } from "../src/app.js";

// Use bun run test (native --isolate), or run this file alone. Unit files globally mock x402.
// Only the AI boundary is replaced; app, pricing, SQLite, cleanup and SDK run unchanged.
const aiCalls: unknown[][] = [];
let aiFails = false;
mock.module("../src/lib/ai.js", () => ({
    generateSocraticResponse: async (...args: unknown[]) => {
        aiCalls.push(structuredClone(args));
        if (aiFails) throw new Error("Local AI fixture unavailable");
        return { reply: "Which assumption could you test?", context_state: "local summary", main_goal: "Learn locally" };
    },
}));

const NETWORK = "eip155:31337";
const WALLET = "0x0000000000000000000000000000000000000001";
const PAY_TO = "0x0000000000000000000000000000000000000002";
const ASSET = "0x0000000000000000000000000000000000000003";
const API_KEY = "local-contract-not-a-credential";
// Opaque fixture ID, NOT a cryptographically valid signature. Only the loopback
// facilitator authorizes this exact fixture; no wallet, gateway or RPC exists.
const PROOF = "0x" + "ab".repeat(65);
const SESSION = "019468c8-b184-7299-80bf-104997327771";
const supported: SupportedResponse = {
    kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { decimals: 6, name: "Local USD", version: "1" } }],
    extensions: [], signers: {},
};
const requirements = (amount: string): PaymentRequirements => ({
    scheme: "exact", network: NETWORK, asset: ASSET, amount, payTo: PAY_TO,
    maxTimeoutSeconds: 300, extra: { name: "Local USD", version: "1" },
});
const payment = (): PaymentPayload => ({
    x402Version: 2,
    resource: { url: "http://localhost/ask", description: "Socratic Consultation", mimeType: "application/json" },
    accepted: requirements("10000"),
    payload: {
        signature: PROOF,
        authorization: { from: WALLET, to: PAY_TO, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) },
    },
});
// Existing app previous-proof identity extension, not a new payment.
const identity = () => "x402 " + btoa(JSON.stringify({ proof: PROOF }));

describe("Bun x402 v2 contract (real SDK, loopback facilitator)", () => {
    let instance: Awaited<ReturnType<typeof createApp>> | undefined;
    let facilitator: ReturnType<typeof Bun.serve> | undefined;
    let fetchSpy: ReturnType<typeof spyOn> | undefined;
    const timers: ReturnType<typeof setInterval>[] = [];
    // SDK's HTTP client adds x402Version to the typed request envelope.
    const requests: { method: string; path: string; auth: string | null; body?: VerifyRequest & { x402Version: number } }[] = [];
    const forbiddenRequests: string[] = [];
    let settleSucceeds = true;
    let settlementFinished = false;

    beforeEach(async () => {
        aiCalls.length = requests.length = forbiddenRequests.length = 0;
        aiFails = false;
        settleSucceeds = true;
        settlementFinished = false;
        facilitator = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(req) {
                const path = new URL(req.url).pathname;
                const entry: typeof requests[number] = { method: req.method, path, auth: req.headers.get("x-api-key") };
                requests.push(entry);
                if (entry.auth !== API_KEY) return new Response("Dummy auth required", { status: 401 });
                if (path === "/supported" && req.method === "GET") return Response.json(supported);
                if ((path === "/verify" || path === "/settle") && req.method === "POST") {
                    const body = await req.json() as VerifyRequest & { x402Version: number };
                    entry.body = body;
                    const authorized = JSON.stringify(body.paymentPayload) === JSON.stringify(payment())
                        && JSON.stringify(body.paymentRequirements) === JSON.stringify(requirements("10000"));
                    if (path === "/verify") {
                        return Response.json({ isValid: authorized, payer: WALLET, ...(!authorized && { invalidReason: "Local fixture rejected" }) } satisfies VerifyResponse);
                    }
                    settlementFinished = true;
                    return Response.json({
                        success: authorized && settleSucceeds, payer: WALLET,
                        transaction: "local-fixture-no-chain-transaction", network: NETWORK,
                        ...(!(authorized && settleSucceeds) && { errorReason: "Local settlement rejected" }),
                    } satisfies SettleResponse);
                }
                return new Response("Unknown local endpoint", { status: 404 });
            },
        });
        const origin = facilitator.url.origin;
        const realFetch = globalThis.fetch;
        const localFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.origin !== origin) {
                forbiddenRequests.push(url.href);
                throw new Error(`Non-fixture fetch prohibited: ${url.href}`);
            }
            return realFetch(input, init);
        }, { preconnect: realFetch.preconnect });
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation(localFetch);
        // App discards cleanup's disposer. Capture the REAL timer for test-owned
        // teardown without replacing the cleanup service or changing production.
        const realSetInterval = globalThis.setInterval;
        const timerSpy = spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
            const timer = realSetInterval(...args);
            timers.push(timer);
            return timer;
        }) as typeof setInterval);
        try {
            const { createApp } = await import("../src/app.js");
            instance = await createApp({
                facilitatorUrl: origin, kobaruApiKey: API_KEY, dbPath: ":memory:",
                skaleWalletAddress: PAY_TO, skaleNetworkId: NETWORK, skaleAssetAddress: ASSET,
                googleApiKey: "local-unused-no-model", pruneInterval: 60_000, sessionMaxAge: 86_400,
            });
        } finally {
            timerSpy.mockRestore();
        }
    });

    afterEach(async () => {
        try {
            // Drain HTTP/settlement callbacks before closing SQLite.
            await Bun.sleep(20);
            instance?.shutdown();
            if (instance) expect(() => instance!.stateManager.getBalance(WALLET)).toThrow();
            expect(forbiddenRequests).toEqual([]);
        } finally {
            instance = undefined;
            for (const timer of timers.splice(0)) clearInterval(timer);
            await facilitator?.stop(true);
            fetchSpy?.mockRestore();
        }
    });

    const ask = (message = "Hello", headers: Record<string, string> = {}, session_id?: string) => instance!.app.request("http://localhost/ask", {
        method: "POST", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ message, ...(session_id && { session_id }) }),
    });
    const waitUntil = async (done: () => boolean) => {
        const deadline = Date.now() + 1000;
        while (!done() && Date.now() < deadline) await Bun.sleep(5);
        expect(done()).toBe(true);
    };

    it("keeps discovery and health free without AI, verification or settlement", async () => {
        for (const path of ["/", "/health"]) {
            const response = await instance!.app.request(path);
            expect(response.status).toBe(200);
            expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
        }
        expect(aiCalls).toHaveLength(0);
        expect(requests.map(r => [r.method, r.path, r.auth])).toEqual([["GET", "/supported", API_KEY]]);
    });

    it("executes official codecs and returns the v2 dynamic deficit without proof or balance", async () => {
        for (const [message, amount] of [["Hello", "985"], ["x".repeat(1000), "1134"]]) {
            const response = await ask(message);
            expect(response.status).toBe(402);
            const body = await response.json();
            const header = response.headers.get("PAYMENT-REQUIRED")!;
            expect(header).not.toBeNull();
            // JSON-string mock codecs must not masquerade as the SDK's base64 codec.
            expect(header.startsWith("{")).toBe(false);
            expect(JSON.parse(atob(header))).toEqual(body);
            expect(decodePaymentRequiredHeader(header)).toEqual(body);
            expect(encodePaymentRequiredHeader(body)).toBe(header);
            expect(body.x402Version).toBe(2);
            expect(body.accepts).toEqual([requirements(amount)]);
            expect(body.resource.url).toBe("http://localhost/ask");
            expect(body.extensions["x402-balance"].info).toMatchObject({ supportsBalance: true, supportsTopup: true, identityMechanism: "previous-proof" });
        }
        expect(aiCalls).toHaveLength(0);
        expect(requests.every(r => r.path === "/supported" && r.auth === API_KEY)).toBe(true);
        expect(requests).toHaveLength(3); // startup plus real HTTPResourceServer.initialize per ask
    });

    it("rejects an unauthorized local proof without AI, debit, history or settlement", async () => {
        const rejected = payment();
        rejected.payload.signature = "0x" + "cd".repeat(65);
        const response = await ask("Hello", { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(rejected) }, SESSION);
        expect(response.status).toBe(402);
        expect(decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!).accepts).toEqual([requirements("985")]);
        expect(requests.filter(r => r.path === "/verify")).toHaveLength(1);
        expect(requests.some(r => r.path === "/settle")).toBe(false);
        expect(instance!.stateManager.getBalance(WALLET)).toBe(0n);
        expect(instance!.stateManager.getPayment(PROOF)).toBeNull();
        expect(instance!.stateManager.get(`${WALLET}:${SESSION}`)).toBeNull();
        expect(aiCalls).toHaveLength(0);
    });

    it("settles via real SDK and reuses previous-proof identity without double credit", async () => {
        const payload = payment();
        const encoded = encodePaymentSignatureHeader(payload);
        expect(decodePaymentSignatureHeader(encoded)).toEqual(payload);
        const first = await ask("Hello", { "PAYMENT-SIGNATURE": encoded }, SESSION);
        expect(first.status).toBe(200);
        expect(first.headers.get("X-Balance-Remaining")).toBe("0"); // surplus is not spendable until settlement
        expect(await first.json()).toEqual({ reply: "Which assumption could you test?", session_id: SESSION });
        await waitUntil(() => instance!.stateManager.getPayment(PROOF) !== null);
        expect(instance!.stateManager.getBalance(WALLET)).toBe(9015n);
        for (let i = 0; i < 2; i++) {
            // Even if the old payment header is retained, previous-proof identity
            // must consume balance, not verify/settle/credit the same proof again.
            const response = await ask("Hello", { Authorization: identity(), "PAYMENT-SIGNATURE": encoded }, SESSION);
            expect(response.status).toBe(200);
            expect(response.headers.get("X-Balance-Remaining")).toBe(String(9015 - (i + 1) * 985));
        }
        const external = requests.filter(r => r.path === "/verify" || r.path === "/settle");
        expect(external.map(r => [r.path, r.auth])).toEqual([["/verify", API_KEY], ["/settle", API_KEY]]);
        for (const request of external) expect(request.body).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements("10000") });
        expect(instance!.stateManager.get(`${WALLET}:${SESSION}`)?.history).toEqual(Array.from({ length: 3 }, () => [
            { role: "user" as const, content: "Hello" }, { role: "model" as const, content: "Which assumption could you test?" },
        ]).flat());
        expect(aiCalls[1]?.[1]).toEqual([{ role: "user", content: "Hello" }, { role: "model", content: "Which assumption could you test?" }]);
        expect(aiCalls[1]?.[2]).toBe("local summary");
    });

    it("does not debit insufficient balance or change session history", async () => {
        instance!.stateManager.recordPayment(PROOF, WALLET);
        instance!.stateManager.adjustBalance(WALLET, 100n);
        const response = await ask("Hello", { Authorization: identity() }, SESSION);
        expect(response.status).toBe(402);
        expect(decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!).accepts).toEqual([requirements("885")]);
        expect(instance!.stateManager.getBalance(WALLET)).toBe(100n);
        expect(instance!.stateManager.get(`${WALLET}:${SESSION}`)).toBeNull();
        expect(aiCalls).toHaveLength(0);
    });

    it("refunds the real SQLite reservation when AI fails", async () => {
        instance!.stateManager.recordPayment(PROOF, WALLET);
        instance!.stateManager.adjustBalance(WALLET, 2000n);
        instance!.stateManager.save(`${WALLET}:${SESSION}`, "preserved summary", [{ role: "user", content: "Earlier question" }], "Original goal");
        const before = instance!.stateManager.get(`${WALLET}:${SESSION}`);
        aiFails = true;
        const response = await ask("Hello", { Authorization: identity() }, SESSION);
        expect(response.status).toBe(500); // Errors.aiUnavailable is currently HTTP 500
        expect((await response.json()).error).toBe("AI Service Unavailable");
        expect(instance!.stateManager.getBalance(WALLET)).toBe(2000n);
        expect(instance!.stateManager.get(`${WALLET}:${SESSION}`)).toEqual(before);
        expect(aiCalls).toHaveLength(1);
        expect(requests.some(r => r.path === "/verify" || r.path === "/settle")).toBe(false);
    });

    it("does not credit surplus or record identity after failed settlement", async () => {
        settleSucceeds = false;
        const response = await ask("Hello", { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment()) }, SESSION);
        expect(response.status).toBe(200); // current optimistic service behavior
        await waitUntil(() => settlementFinished);
        await Bun.sleep(20);
        expect(requests.filter(r => r.path === "/settle")).toHaveLength(1);
        expect(instance!.stateManager.getBalance(WALLET)).toBe(0n);
        expect(instance!.stateManager.getPayment(PROOF)).toBeNull();
        expect((await ask("Hello", { Authorization: identity() }, SESSION)).status).toBe(402);
        expect(aiCalls).toHaveLength(1);
    });
});
