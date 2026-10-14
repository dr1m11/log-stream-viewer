/**
 * Exhaustiveness guard for discriminated unions: calling it means a case was not handled.
 * The compiler rejects the call while any variant is left unhandled.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
