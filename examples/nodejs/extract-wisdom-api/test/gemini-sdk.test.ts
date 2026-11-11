import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiAdapter } from "../src/infra/adapters/GeminiAdapter.js";
import { getSystemInstruction } from "../src/core/prompts/ExtractWisdom.js";
import { FinishReason } from "@google/genai";

afterEach(() => vi.unstubAllGlobals());

describe("real Google GenAI SDK with an in-memory HTTP boundary", () => {
    it.each([FinishReason.RECITATION, FinishReason.SAFETY, FinishReason.LANGUAGE])("rejects legacy blocked reason %s even with valid JSON text", async finishReason => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
            candidates: [{ finishReason, content: { parts: [{ text: '{"summary":"blocked fixture","ideas":[],"quotes":[],"references":[]}' }] } }]
        }));
        vi.stubGlobal("fetch", fetch);
        await expect(new GeminiAdapter("fixture-key").extractWisdom("text", "en", "en")).rejects.toThrow("Failed to extract wisdom");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([{}, { candidates: [] }, { candidates: [{ finishReason: FinishReason.STOP }] }, {
        promptFeedback: { blockReason: "SAFETY" }
    }])("rejects missing candidates or text through the real SDK: %j", async response => {
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response)));
        await expect(new GeminiAdapter("fixture-key").extractWisdom("text", "en", "en")).rejects.toThrow("Failed to extract wisdom");
    });

    it.each([FinishReason.STOP, FinishReason.MAX_TOKENS])("accepts valid JSON with nonblocked reason %s", async finishReason => {
        const wisdom = { summary: "nonblocked fixture", ideas: [], quotes: [], references: [] };
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
            candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(wisdom) }] } }]
        })));
        expect(await new GeminiAdapter("fixture-key").extractWisdom("text", "en", "en")).toEqual(wisdom);
    });

    it("serializes the preserved model, transcript, prompt, JSON mode and explicit API key", async () => {
        const wisdom = { summary: "SDK fixture", ideas: [], quotes: [], references: [] };
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(wisdom) }] } }],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 }
        }), { headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetch);
        expect(await new GeminiAdapter("fixture-only-key").extractWisdom("fixture transcript", "es", "pt")).toEqual(wisdom);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [input, init] = fetch.mock.calls[0];
        const request = new Request(input, init);
        expect(request.url).toBe("https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent");
        expect(request.headers.get("x-goog-api-key")).toBe("fixture-only-key");
        expect(await request.json()).toMatchObject({
            contents: [{ role: "user", parts: [{ text: "fixture transcript" }] }],
            systemInstruction: { parts: [{ text: getSystemInstruction("es", "pt") }] },
            generationConfig: { responseMimeType: "application/json" }
        });
    });

    it("maps a real SDK API error to the established external error", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
            error: { code: 400, message: "fixture provider error", status: "INVALID_ARGUMENT" }
        }), { status: 400, headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetch);
        await expect(new GeminiAdapter("fixture-only-key").extractWisdom("text", "en", "en")).rejects.toThrow("Failed to extract wisdom");
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
