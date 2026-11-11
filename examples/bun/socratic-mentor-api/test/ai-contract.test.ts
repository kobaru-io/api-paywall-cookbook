import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { NoObjectGeneratedError } from "ai";
import { generateSocraticResponse, ResponseSchema } from "../src/lib/ai.js";
import { PROMPT_DELIMITER } from "../src/lib/prompt-security.js";
import { SOCRATIC_SYSTEM_PROMPT } from "../src/lib/prompt.js";

// Real AI SDK and Google provider; the HTTP transport is an in-process fixture.
describe("structured Socratic response contract (real SDK)", () => {
    const answer = { reply: "What could you measure?", context_state: "Prior context", main_goal: "Learn physics" };
    let responseText: string;
    let transportError: Error | undefined;
    let fetchSpy: ReturnType<typeof spyOn>;
    let originalKey: string | undefined;
    const calls: { url: string; body: Record<string, unknown> }[] = [];

    beforeEach(() => {
        calls.length = 0;
        responseText = JSON.stringify(answer);
        transportError = undefined;
        originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = "local-fixture-not-a-credential";
        const fixtureFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            if (transportError) throw transportError;
            return Response.json({
                candidates: [{ content: { role: "model", parts: [{ text: responseText }] }, finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }
            });
        }, { preconnect: globalThis.fetch.preconnect });
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fixtureFetch);
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        if (originalKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
    });

    it("preserves the model, prompt, delimiters, schema and all returned state", async () => {
        const result = await generateSocraticResponse("Hello", [{ role: "user", content: "Earlier question" }], "Summary", "Goal", "still-unused-parameter");
        expect(result).toEqual(answer);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain("/models/gemini-2.5-flash:generateContent");
        const body = calls[0]?.body;
        expect(body?.systemInstruction).toEqual({ parts: [{ text: SOCRATIC_SYSTEM_PROMPT }] });
        const contents = JSON.stringify(body?.contents);
        for (const text of ["Hello", "USER: Earlier question", "Summary", "Goal", PROMPT_DELIMITER]) {
            expect(contents).toContain(text);
        }
        expect(body?.generationConfig).toMatchObject({ responseMimeType: "application/json" });
        expect(JSON.stringify(body?.generationConfig)).toContain("context_state");
        expect(JSON.stringify(body?.generationConfig)).toContain("main_goal");
    });

    it("preserves empty-context defaults", async () => {
        await generateSocraticResponse("Hello", [], "", "");
        const body = JSON.stringify(calls[0]?.body);
        for (const text of ["(Unset - Please Infer)", "(No previous summary)", "(No recent history)"]) expect(body).toContain(text);
    });

    for (const [label, value] of [
        ["malformed JSON", "not JSON"],
        ["missing state", JSON.stringify({ reply: "Only a reply" })],
        ["wrong field type", JSON.stringify({ ...answer, main_goal: 123 })]
    ]) {
        it(`rejects ${label} instead of returning an invalid response`, async () => {
            responseText = value;
            await expect(generateSocraticResponse("Hello", [], "", "")).rejects.toBeInstanceOf(NoObjectGeneratedError);
        });
    }

    it("propagates provider failures to the route's existing refund/error path", async () => {
        transportError = new Error("Local provider fixture unavailable");
        await expect(generateSocraticResponse("Hello", [], "", "")).rejects.toThrow("Local provider fixture unavailable");
    });

    it("keeps all three string fields required without adding a new length restriction", () => {
        expect(ResponseSchema.safeParse(answer).success).toBe(true);
        expect(ResponseSchema.safeParse({ ...answer, reply: "x".repeat(10001) }).success).toBe(true);
        expect(ResponseSchema.safeParse({}).success).toBe(false);
        expect(ResponseSchema.safeParse({ ...answer, context_state: null }).success).toBe(false);
    });
});
