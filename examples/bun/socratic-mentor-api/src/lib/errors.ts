import { Context } from "hono";

/**
 * Standardized API error response format.
 * 
 * All error responses follow this structure:
 * - error: A short, machine-readable error code (e.g., "Invalid Input", "AI Service Unavailable")
 * - message: A human-readable description of the error
 * - details: Optional additional information (validation errors, debug info)
 * - requestId: The request ID for tracing (if available)
 * 
 * NOTE: Payment-related errors (402 responses) are passed through directly from the
 * x402 facilitator. These include standardized error codes such as:
 * 
 * - insufficient_funds: Client does not have enough tokens
 * - invalid_exact_evm_payload_authorization_valid_after: Payment not yet valid
 * - invalid_exact_evm_payload_authorization_valid_before: Payment expired
 * - invalid_exact_evm_payload_authorization_value: Amount insufficient
 * - invalid_exact_evm_payload_signature: Invalid signature
 * - invalid_exact_evm_payload_recipient_mismatch: Wrong recipient
 * - invalid_network: Unsupported blockchain network
 * - invalid_payload: Malformed payment payload
 * - invalid_scheme / unsupported_scheme: Payment scheme not supported
 * - invalid_x402_version: Protocol version not supported
 * - invalid_transaction_state: Blockchain transaction failed
 * - unexpected_verify_error / unexpected_settle_error: Unexpected errors
 * 
 * These are NOT defined here as they originate from the facilitator, not this API.
 */
export interface ApiError {
    error: string;
    message: string;
    details?: unknown;
    requestId?: string;
}

/**
 * Creates a standardized error response.
 * 
 * @param c - Hono context
 * @param status - HTTP status code
 * @param error - Short error code (e.g., "Invalid Input")
 * @param message - Human-readable error message
 * @param details - Optional additional details
 */
export function errorResponse(
    c: Context,
    status: number,
    error: string,
    message: string,
    details?: unknown
) {
    const requestId = c.get("requestId") || undefined;

    const body: ApiError = {
        error,
        message,
        ...(details ? { details } : {}),
        ...(requestId && { requestId })
    };

    return c.json(body, status as any);
}

/**
 * Common error responses for convenience
 */
export const Errors = {
    invalidJson: (c: Context) =>
        errorResponse(c, 400, "Invalid JSON", "Request body must be valid JSON"),

    invalidInput: (c: Context, details: unknown) =>
        errorResponse(c, 400, "Invalid Input", "Request validation failed", details),

    insufficientBalance: (c: Context) =>
        errorResponse(c, 402, "Insufficient Balance", "Payment required to proceed"),

    aiUnavailable: (c: Context) =>
        errorResponse(c, 500, "AI Service Unavailable", "The AI service is temporarily unavailable. Please try again later."),

    internalError: (c: Context, message = "An unexpected error occurred") =>
        errorResponse(c, 500, "Internal Error", message)
};
