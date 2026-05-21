/**
 * Single source of truth for "couldn't close this position" error messaging.
 *
 * Both the Telegram `ClosePositionCapability` and the mini-app HTTP route
 * (`POST /predictionMarket/positions/:id/close`) need identical user-facing
 * copy and the same HTTP status mapping. Adding a new domain error code from
 * `initiateClose`/`previewClose` is a one-edit change here.
 */

export interface CloseErrorMapping {
  /** HTTP status the API surface should return. */
  httpStatus: number;
  /** Stable error code echoed in the JSON body for FE programmatic handling. */
  code: string;
  /** User-facing message — used verbatim in chat replies and HTTP bodies. */
  message: string;
}

export function humanizeCloseError(err: unknown): CloseErrorMapping {
  const code = err instanceof Error ? err.message.split(":")[0] ?? "" : "";
  switch (code) {
    case "POSITION_NOT_FOUND":
      return { httpStatus: 404, code, message: "That position no longer exists." };
    case "POSITION_WRONG_STATUS":
      return { httpStatus: 409, code, message: "This position isn't open for closing right now." };
    case "BET_IN_FLIGHT":
      return {
        httpStatus: 409,
        code,
        message: "You already have a bet being placed. Wait for it to settle, then try again.",
      };
    default:
      return { httpStatus: 500, code: "INTERNAL", message: "Couldn't start the close. Please try again." };
  }
}
