import { isAddress } from "viem";
import { INTENT_ACTION } from "../../../../helpers/enums/intentAction.enum";
import type {
  IntentPackage,
  Address,
} from "../../../../use-cases/interface/output/intentParser.interface";
import type { ToolManifest } from "../../../../use-cases/interface/output/toolManifest.types";

export class MissingFieldsError extends Error {
  constructor(
    public readonly missingFields: string[],
    public readonly prompt: string,
  ) {
    super(prompt);
    this.name = "MissingFieldsError";
  }
}

export class InvalidFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly prompt: string,
  ) {
    super(prompt);
    this.name = "InvalidFieldError";
  }
}

export class ConversationLimitError extends Error {
  constructor() {
    super(
      "I wasn't able to collect all the required information after 10 messages. " +
        'Please start over with a complete request, e.g. "Swap 100 USDC for AVAX" or "Send 5 RON to 0xabc...".',
    );
    this.name = "ConversationLimitError";
  }
}

export const WINDOW_SIZE = 10;

const REQUIRED_FIELDS: Partial<
  Record<INTENT_ACTION, Array<keyof IntentPackage>>
> = {
  [INTENT_ACTION.SWAP]: ["fromTokenSymbol", "toTokenSymbol", "amountHuman"],
  [INTENT_ACTION.TRANSFER]: ["fromTokenSymbol", "amountHuman", "recipient"],
  [INTENT_ACTION.STAKE]: ["fromTokenSymbol", "amountHuman"],
  [INTENT_ACTION.UNSTAKE]: ["fromTokenSymbol", "amountHuman"],
  [INTENT_ACTION.CLAIM_REWARDS]: [],
};

const FIELD_PROMPTS: Partial<Record<keyof IntentPackage, string>> = {
  fromTokenSymbol: "which token to send",
  toTokenSymbol: "which token to receive",
  amountHuman: "how much",
  recipient: "the recipient address (0x...)",
};

/**
 * Validates a parsed IntentPackage against domain rules.
 * Throws MissingFieldsError, InvalidFieldError, or ConversationLimitError.
 * Mutates `intent.recipient` to the Address branded type on success.
 * When `manifest` is provided, required fields come from its inputSchema.required.
 */
export function validateIntent(
  intent: IntentPackage,
  messageCount: number,
  manifest?: ToolManifest,
): void {
  const atLimit = messageCount >= WINDOW_SIZE;

  let required: string[];
  if (manifest) {
    const schema = manifest.inputSchema as { required?: string[] };
    required = schema.required ?? [];
  } else {
    required = (REQUIRED_FIELDS[intent.action as INTENT_ACTION] ?? []) as string[];
  }

  const missingFields = required.filter((field) => {
    const val = (intent as unknown as Record<string, unknown>)[field] ?? intent.params?.[field];
    return val == null;
  });

  if (missingFields.length > 0) {
    if (atLimit) throw new ConversationLimitError();
    const descriptions = missingFields.map((f) => {
      return FIELD_PROMPTS[f as keyof IntentPackage] ?? f;
    });
    throw new MissingFieldsError(
      missingFields,
      `To complete your ${intent.action}, I still need: ${descriptions.join(", ")}.`,
    );
  }

  // Recipient must be a valid Ethereum address
  if (intent.recipient != null) {
    if (!isAddress(intent.recipient)) {
      throw new InvalidFieldError(
        "recipient",
        `"${intent.recipient}" is not a valid Ethereum address. Please provide a valid 0x... address.`,
      );
    }
    (intent as { recipient: Address }).recipient = intent.recipient as Address;
  }

  // Amount must be a finite positive number
  if (intent.amountHuman != null) {
    const amount = parseFloat(intent.amountHuman);
    if (isNaN(amount) || amount <= 0) {
      throw new InvalidFieldError(
        "amountHuman",
        `"${intent.amountHuman}" is not a valid amount. Please provide a positive number.`,
      );
    }
  }
}
