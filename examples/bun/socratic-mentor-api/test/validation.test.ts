import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Errors, errorResponse } from "../src/lib/errors.js";
import { AskRequestSchema, MAX_MESSAGE_LENGTH, MAX_MAIN_GOAL_LENGTH } from "../src/lib/validation.js";
import { requestIdMiddleware } from "../src/middleware/request-id.js";

function createValidationBoundary() {
    const app = new Hono();
    app.use("*", requestIdMiddleware());
    app.post("/", async c => {
        const result = AskRequestSchema.safeParse(await c.req.json());
        if (result.success) return c.json(result.data);
        return Errors.invalidInput(c, result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })));
    });
    return app;
}

describe("request validation and error contracts", () => {
    it("preserves valid input sanitization and optional fields", () => {
        expect(AskRequestSchema.parse({ message: "  Hello\u0000\nworld  ", main_goal: " Goal " })).toEqual({
            message: "Hello\nworld", main_goal: "Goal"
        });
        expect(AskRequestSchema.parse({ message: "x".repeat(MAX_MESSAGE_LENGTH) }).message).toHaveLength(MAX_MESSAGE_LENGTH);
    });

    for (const [label, input, path] of [
        ["missing message", {}, "message"],
        ["non-string message", { message: 1 }, "message"],
        ["empty message", { message: "" }, "message"],
        ["sanitized empty message", { message: " \u0000 " }, "message"],
        ["oversized message", { message: "x".repeat(MAX_MESSAGE_LENGTH + 1) }, "message"],
        ["oversized goal", { message: "Hello", main_goal: "x".repeat(MAX_MAIN_GOAL_LENGTH + 1) }, "main_goal"],
        ["malformed session", { message: "Hello", session_id: "not-a-uuid" }, "session_id"]
    ] as const) {
        it(`keeps ${label} mapped to the existing HTTP 400 error`, async () => {
            const app = createValidationBoundary();
            const response = await app.request("/", { method: "POST", body: JSON.stringify(input) });
            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body).toMatchObject({ error: "Invalid Input", message: "Request validation failed", details: [{ path }] });
            expect(body.requestId).toBe(response.headers.get("X-Request-ID"));
            expect(body.requestId).toMatch(/^[0-9a-f]{8}$/);
        });
    }

    for (const [label, session_id] of [
        ["non-RFC version and variant", "12345678-1234-1234-1234-123456789abc"],
        ["generated v7 shape", "019468c8-b184-7299-80bf-104997327771"],
        ["uppercase hexadecimal", "ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456"],
        ["nil UUID", "00000000-0000-0000-0000-000000000000"],
        ["max UUID", "ffffffff-ffff-ffff-ffff-ffffffffffff"]
    ]) {
        it(`preserves baseline session acceptance for ${label}`, async () => {
            const input = { message: "Hello", session_id };
            expect(AskRequestSchema.parse(input)).toEqual(input);
            const response = await createValidationBoundary().request("/", { method: "POST", body: JSON.stringify(input) });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(input);
        });
    }

    it("keeps missing optional session and goal fields absent", async () => {
        const input = { message: "Hello" };
        expect(AskRequestSchema.parse(input)).toEqual(input);
        const response = await createValidationBoundary().request("/", { method: "POST", body: JSON.stringify(input) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(input);
    });

    for (const [label, input, path, message] of [
        ["missing message", {}, "message", "Invalid input: expected string, received undefined"],
        ["numeric message", { message: 1 }, "message", "Invalid input: expected string, received number"],
        ["numeric session", { message: "Hello", session_id: 1 }, "session_id", "Invalid input: expected string, received number"],
        ["null session", { message: "Hello", session_id: null }, "session_id", "Invalid input: expected string, received null"],
        ["numeric goal", { message: "Hello", main_goal: 1 }, "main_goal", "Invalid input: expected string, received number"],
        ["null goal", { message: "Hello", main_goal: null }, "main_goal", "Invalid input: expected string, received null"],
        ["null root", null, "", "Invalid input: expected object, received null"],
        ["array root", [], "", "Invalid input: expected object, received array"],
        ["string root", "Hello", "", "Invalid input: expected object, received string"],
        ["short UUID group", { message: "Hello", session_id: "1234567-1234-1234-1234-123456789abc" }, "session_id", "Invalid session ID format"],
        ["non-hex UUID", { message: "Hello", session_id: "12345678-1234-1234-1234-123456789abg" }, "session_id", "Invalid session ID format"]
    ] as const) {
        it(`returns the explicitly accepted Zod 4 details for ${label}`, async () => {
            const response = await createValidationBoundary().request("/", { method: "POST", body: JSON.stringify(input) });
            expect(response.status).toBe(400);
            const body = await response.json();
            expect(body).toEqual({
                error: "Invalid Input", message: "Request validation failed",
                details: [{ path, message }], requestId: response.headers.get("X-Request-ID")
            });
            expect(body.requestId).toMatch(/^[0-9a-f]{8}$/);
        });
    }

    it("preserves truthy details and omits falsy details without unsafe spreading", async () => {
        for (const details of [undefined, null, false, 0, "", "diagnostic", 12, ["detail"], { reason: "fixture" }]) {
            const app = new Hono();
            app.get("/", c => errorResponse(c, 500, "Fixture Error", "Fixture message", details));
            const body = await (await app.request("/")).json();
            expect(body).toEqual({ error: "Fixture Error", message: "Fixture message", ...(details ? { details } : {}) });
        }
    });
});
