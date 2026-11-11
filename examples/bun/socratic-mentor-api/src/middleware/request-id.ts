import { Context, Next } from "hono";
import { v7 as uuidv7 } from "uuid";

declare module "hono" {
    interface ContextVariableMap {
        requestId: string;
    }
}

/**
 * Request ID middleware for distributed tracing and debugging.
 * 
 * Generates a unique short ID for each request and:
 * - Stores it in the context for use in logs
 * - Returns it in the X-Request-ID response header
 * - Enables correlation of logs across async operations
 */
export function requestIdMiddleware() {
    return async (c: Context, next: Next) => {
        // Generate short 8-character request ID from UUID v7
        const requestId = uuidv7().slice(0, 8);

        // Store in context for use in route handlers and other middleware
        c.set("requestId", requestId);

        // Add to response headers for client-side tracing
        c.header("X-Request-ID", requestId);

        await next();
    };
}

/**
 * Helper to get request ID from context.
 * Returns empty string if not set (shouldn't happen if middleware is applied).
 */
export function getRequestId(c: Context): string {
    return c.get("requestId") || "";
}
