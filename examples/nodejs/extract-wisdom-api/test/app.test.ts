import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, SettleRequest, SettleResponse, SupportedResponse, VerifyRequest, VerifyResponse } from "@x402/core/types";
import type { Hono } from "hono";

const clients = vi.hoisted(() => ({ transcript: vi.fn(), generate: vi.fn() }));
vi.mock("youtube-transcript-plus", () => ({ fetchTranscript: clients.transcript }));
vi.mock("@google/generative-ai", () => ({
    GoogleGenerativeAI: class {
        getGenerativeModel() { return { generateContent: clients.generate }; }
    }
}));

const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const asset = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const wallet = "11111111111111111111111111111111";
const wisdom = { summary: "Local fixture", ideas: [], quotes: [], references: [] };
const supported: SupportedResponse = JSON.parse(readFileSync(new URL("./fixtures/supported-v2.json", import.meta.url), "utf8"));
let server: Server;
let app: Hono;
let calls: { path: string; authorization?: string; body?: VerifyRequest | SettleRequest }[];
let verifyResult: VerifyResponse;
let settleResult: SettleResponse;

beforeAll(async () => {
    server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        calls.push({ path: req.url!, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
        res.setHeader("content-type", "application/json");
        if (req.url === "/supported") res.end(JSON.stringify(supported));
        else if (req.url === "/verify") res.end(JSON.stringify(verifyResult));
        else if (req.url === "/settle") res.end(JSON.stringify(settleResult));
        else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    vi.stubEnv("FACILITATOR_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("GOOGLE_API_KEY", "test-only-google-key");
    vi.stubEnv("KOBARU_API_KEY", "test-only-facilitator-key");
    vi.stubEnv("RESOURCE_WALLET_ADDRESS", wallet);
    vi.stubEnv("SOLANA_NETWORK_ID", network);
    vi.stubEnv("USDC_ASSET_ADDRESS", asset);
});

beforeEach(async () => {
    calls = [];
    verifyResult = { isValid: false, invalidReason: "invalid_transaction" };
    settleResult = { success: true, transaction: "local-fixture-not-a-chain-transaction", network };
    clients.transcript.mockReset().mockResolvedValue([{ text: "a".repeat(80000), lang: "pt", offset: 0, duration: 1 }]);
    clients.generate.mockReset().mockResolvedValue({ response: { text: () => JSON.stringify(wisdom) } });
    vi.resetModules();
    app = (await import("../src/presentation/http/app.js")).default;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
});

function request(body: unknown = { url: "https://youtu.be/fixture" }, signature?: string) {
    return app.request("http://localhost/wisdom", {
        method: "POST",
        headers: { "content-type": "application/json", ...(signature ? { "PAYMENT-SIGNATURE": signature } : {}) },
        body: JSON.stringify(body)
    });
}

async function quote(body?: unknown): Promise<PaymentRequired> {
    const response = await request(body);
    expect(response.status).toBe(402);
    const header = response.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    return decodePaymentRequiredHeader(header!);
}

function signature(required: PaymentRequired, accepted = required.accepts[0]) {
    // The fixture facilitator controls verification. This is not a cryptographic payment proof.
    return encodePaymentSignatureHeader({
        x402Version: 2, resource: required.resource, accepted,
        payload: { transaction: "local-fixture-only" }
    });
}

describe("HTTP contracts with the real x402 SDK and a loopback facilitator", () => {
    it("keeps the free introduction and absent health endpoint", async () => {
        expect((await app.request("/")).status).toBe(200);
        expect(await (await app.request("/")).json()).toMatchObject({ name: "Wizard's Wisdom API" });
        expect((await app.request("/health")).status).toBe(404);
        expect(clients.generate).not.toHaveBeenCalled();
    });

    it("quotes dynamic SVM USDC pricing, caches the transcript and preserves Bazaar", async () => {
        const required = await quote();
        expect(required.x402Version).toBe(2);
        expect(required.accepts).toHaveLength(1);
        expect(required.accepts[0]).toMatchObject({ scheme: "exact", network, asset, payTo: wallet, amount: "20000", maxTimeoutSeconds: 300, extra: { feePayer: wallet } });
        expect(required.resource).toMatchObject({ url: "http://localhost/wisdom", mimeType: "application/json" });
        expect(required.extensions).toMatchObject({ bazaar: { info: { title: "Wizard's Wisdom API", tags: ["ai", "content-analysis", "video-processing"], provider: { name: "Kobaru.io" }, input: { method: "POST", body: { language: "en" } } } } });
        await quote();
        expect(clients.transcript).toHaveBeenCalledTimes(1);
        expect(clients.generate).not.toHaveBeenCalled();
        expect(calls.some(c => c.path === "/supported" && c.authorization === "Bearer test-only-facilitator-key")).toBe(true);
        expect(calls.some(c => c.path === "/verify" || c.path === "/settle")).toBe(false);
    });

    it("uses the floor without fetching a missing URL", async () => {
        expect((await quote({})).accepts[0].amount).toBe("10000");
        expect(clients.transcript).not.toHaveBeenCalled();
        expect(clients.generate).not.toHaveBeenCalled();
    });

    it("rejects an invalid URL before fetching or charging", async () => {
        expect((await request({ url: "https://evil.example/video" })).status).toBe(400);
        expect(clients.transcript).not.toHaveBeenCalled();
        expect(clients.generate).not.toHaveBeenCalled();
    });

    it("preserves missing transcript 404 and empty transcript 500 without Google", async () => {
        clients.transcript.mockRejectedValueOnce(Object.assign(new Error("Disabled"), { name: "YoutubeTranscriptDisabledError" }));
        expect((await request()).status).toBe(404);
        clients.transcript.mockResolvedValueOnce([]);
        expect((await request()).status).toBe(500);
        expect(clients.generate).not.toHaveBeenCalled();
        expect(calls.some(c => c.path === "/settle")).toBe(false);
    });

    it("does not authorize the handler for a rejected proof", async () => {
        const required = await quote();
        expect((await request(undefined, signature(required))).status).toBe(402);
        expect(calls.filter(c => c.path === "/verify")).toHaveLength(1);
        expect(calls.find(c => c.path === "/verify")).toMatchObject({ authorization: "Bearer test-only-facilitator-key", body: { paymentRequirements: required.accepts[0] } });
        expect(calls.some(c => c.path === "/settle")).toBe(false);
        expect(clients.generate).not.toHaveBeenCalled();
    });

    it("does not authorize malformed signatures or a mismatched network/asset", async () => {
        const required = await quote();
        verifyResult = { isValid: true };
        for (const proof of ["not-base64", signature(required, { ...required.accepts[0], network: "solana:wrong" }), signature(required, { ...required.accepts[0], asset: "wrong" })]) {
            expect((await request(undefined, proof)).status).toBe(402);
        }
        expect(clients.generate).not.toHaveBeenCalled();
        expect(calls.some(c => c.path === "/verify")).toBe(false);
        expect(calls.some(c => c.path === "/settle")).toBe(false);
    });

    it("runs the handler only after fixture verification, reuses cache and settles with auth", async () => {
        const required = await quote();
        verifyResult = { isValid: true, payer: wallet };
        const response = await request({ url: "https://youtu.be/fixture", language: "es" }, signature(required));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(wisdom);
        expect(clients.transcript).toHaveBeenCalledTimes(1);
        expect(clients.generate).toHaveBeenCalledTimes(1);
        expect(calls.filter(c => c.path === "/verify" || c.path === "/settle").map(c => c.path)).toEqual(["/verify", "/settle"]);
        expect(calls.find(c => c.path === "/settle")).toMatchObject({ authorization: "Bearer test-only-facilitator-key", body: { paymentRequirements: required.accepts[0] } });
        expect(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!)).toMatchObject(settleResult);
    });

    it("does not return successful wisdom when settlement fails", async () => {
        const required = await quote();
        verifyResult = { isValid: true };
        settleResult = { success: false, errorReason: "local_settlement_rejected", transaction: "", network };
        expect((await request(undefined, signature(required))).status).toBe(402);
        expect(clients.generate).toHaveBeenCalledTimes(1);
    });
});
