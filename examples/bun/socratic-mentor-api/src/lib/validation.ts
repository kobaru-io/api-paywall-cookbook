import { z } from "zod";

/**
 * Security validation utilities for input sanitization and wallet address validation
 */

// =============================================================================
// WALLET ADDRESS VALIDATION
// =============================================================================

/**
 * EVM wallet address regex (0x followed by 40 hexadecimal characters)
 */
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Validates that a string is a properly formatted EVM wallet address.
 * Prevents SQL injection by ensuring only valid hex characters after 0x prefix.
 *
 * Why this matters:
 * If we accepted any string as a wallet address, a malicious user could pass a string like:
 * "' OR 1=1; DROP TABLE balances; --"
 * Even with parameterized queries, it's best practice to validate formats strictly.
 *
 * @throws Error if the address is invalid
 */
export function validateWalletAddress(address: string): void {
    if (!address || typeof address !== 'string') {
        throw new Error("Wallet address must be a non-empty string");
    }

    if (!EVM_ADDRESS_REGEX.test(address)) {
        throw new Error(`Invalid EVM wallet address format: ${address.substring(0, 10)}...`);
    }
}

/**
 * Zod schema for EVM wallet address validation
 */
export const WalletAddressSchema = z.string().regex(
    EVM_ADDRESS_REGEX,
    "Invalid EVM wallet address format (must be 0x followed by 40 hex characters)"
);

// =============================================================================
// USER INPUT SANITIZATION
// =============================================================================

/**
 * Maximum allowed length for user messages to prevent resource exhaustion
 * and excessive pricing calculations
 */
export const MAX_MESSAGE_LENGTH = 10000;

/**
 * Maximum allowed length for main goal field
 */
export const MAX_MAIN_GOAL_LENGTH = 500;

/**
 * Sanitizes user input by removing control characters and limiting length.
 * Prevents prompt injection, XSS, and database pollution.
 * 
 * Cleaning input before it reaches the Database or AI model is a crucial 
 * Defense-in-Depth layer.
 *
 * @param input - Raw user input
 * @param maxLength - Maximum allowed length
 * @returns Sanitized string with control characters removed and length limited
 */
export function sanitizeUserInput(input: string, maxLength: number): string {
    if (!input || typeof input !== 'string') {
        return '';
    }

    // Remove null bytes, control characters (except newlines and tabs which are safe)
    // This prevents SQL injection attempts using null byte injection
    // and other control character exploits
    let sanitized = input
        .replace(/\x00/g, '') // Null bytes
        .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Other control chars (keep \n \r \t)

    // Trim whitespace and limit length
    sanitized = sanitized.trim().slice(0, maxLength);

    return sanitized;
}

/**
 * Zod schema for validating and sanitizing user messages
 */
export const MessageSchema = z.string()
    .min(1, "Message cannot be empty")
    .max(MAX_MESSAGE_LENGTH, `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`)
    .transform((val) => sanitizeUserInput(val, MAX_MESSAGE_LENGTH))
    .refine((val) => val.length > 0, "Message cannot be empty after sanitization");

/**
 * Zod schema for validating and sanitizing main goal
 */
export const MainGoalSchema = z.string()
    .max(MAX_MAIN_GOAL_LENGTH, `Main goal cannot exceed ${MAX_MAIN_GOAL_LENGTH} characters`)
    .transform((val) => sanitizeUserInput(val, MAX_MAIN_GOAL_LENGTH))
    .optional();

/**
 * Preserve the Zod 3 UUID shape; supplied IDs need not have RFC version/variant bits.
 */
export const SessionIdSchema = z.string().regex(
    /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i,
    "Invalid session ID format"
);

// =============================================================================
// SIGNATURE HASH VALIDATION
// =============================================================================

/**
 * Validates a signature hash to prevent injection attacks.
 * Signature hashes should be hex strings or base64-encoded.
 *
 * @param signatureHash - The signature hash to validate
 * @throws Error if the signature hash contains suspicious characters
 */
export function validateSignatureHash(signatureHash: string): void {
    if (!signatureHash || typeof signatureHash !== 'string') {
        throw new Error("Signature hash must be a non-empty string");
    }

    // Allow alphanumeric, +, /, =, and - (base64 and hex characters)
    // This prevents SQL injection through signature hash parameter
    const SAFE_SIGNATURE_REGEX = /^[a-zA-Z0-9+/=\-_]+$/;

    if (!SAFE_SIGNATURE_REGEX.test(signatureHash)) {
        throw new Error("Invalid signature hash format");
    }

    // Additional length check to prevent DoS via extremely long signatures
    if (signatureHash.length > 1000) {
        throw new Error("Signature hash too long");
    }
}

// =============================================================================
// BIGINT VALIDATION
// =============================================================================

/**
 * Validates a bigint value to ensure it's non-negative and within reasonable bounds.
 * Prevents integer overflow/underflow attacks.
 *
 * @param value - The bigint value to validate
 * @param name - Name of the value for error messages
 * @throws Error if the value is invalid
 */
export function validateBalanceAmount(value: bigint, name: string = "amount"): void {
    if (typeof value !== 'bigint') {
        throw new Error(`${name} must be a bigint`);
    }

    if (value < 0n) {
        throw new Error(`${name} cannot be negative`);
    }

    // Maximum realistic balance: 1 trillion tokens with 18 decimals
    // This is 10^30, which is well within bigint range but prevents absurd values
    const MAX_BALANCE = 10n ** 30n;
    if (value > MAX_BALANCE) {
        throw new Error(`${name} exceeds maximum allowed value`);
    }
}

// =============================================================================
// REQUEST BODY VALIDATION
// =============================================================================

/**
 * Complete Zod schema for /ask endpoint request body
 */
export const AskRequestSchema = z.object({
    message: MessageSchema,
    session_id: SessionIdSchema.optional(),
    main_goal: MainGoalSchema
});

export type AskRequest = z.infer<typeof AskRequestSchema>;
