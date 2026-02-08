import { v4 as uuidv4 } from "uuid";

/**
 * Generate a new UUID v4. Use this everywhere an id is needed.
 */
export function newUuid(): string {
  return uuidv4();
}
