import { beforeEach, describe, it, expect, mock } from "bun:test";
import { generateSocraticResponse } from "../src/lib/ai.js";

// Mock the AI SDK
const mockGenerateText = mock(() => Promise.resolve({
    output: {
        reply: "What do you think?",
        context_state: "User asked a question.",
        main_goal: "Learn Physics"
    }
}));

mock.module("ai", () => ({
    generateText: mockGenerateText,
    Output: { object: mock((options: unknown) => options) }
}));

mock.module("@ai-sdk/google", () => ({
    google: mock(() => "mock-model")
}));

describe("AI Logic", () => {
    beforeEach(() => mockGenerateText.mockClear());

    it("calls the confirmed structured-output API and preserves response fields", async () => {
        const response = await generateSocraticResponse(
            "Hello",
            [],
            "Summary",
            "Goal",
            "key"
        );

        expect(response).toEqual({
            reply: "What do you think?",
            context_state: "User asked a question.",
            main_goal: "Learn Physics"
        });
        expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });
});
