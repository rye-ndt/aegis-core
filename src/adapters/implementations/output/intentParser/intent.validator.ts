import { isAddress } from "viem";
import { INTENT_ACTION } from "../../../../helpers/enums/intentAction.enum";
import { TOOL_CATEGORY } from "../../../../helpers/enums/toolCategory.enum";
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

// Keyed by INTENT_ACTION string values AND TOOL_CATEGORY string values.
// TOOL_CATEGORY.SWAP === INTENT_ACTION.SWAP ("swap") so they share one entry.
// TOOL_CATEGORY.ERC20_TRANSFER ("erc20_transfer") differs from INTENT_ACTION.TRANSFER ("transfer"),
// so it gets its own entry to ensure recipient is required for erc20_transfer manifests.
const REQUIRED_FIELDS: Partial<Record<string, Array<keyof IntentPackage>>> = {
  [INTENT_ACTION.SWAP]:         ["fromTokenSymbol", "toTokenSymbol", "amountHuman"],
  [INTENT_ACTION.TRANSFER]:     ["fromTokenSymbol", "amountHuman", "recipient"],
  [TOOL_CATEGORY.ERC20_TRANSFER]: ["fromTokenSymbol", "amountHuman", "recipient"],
  [INTENT_ACTION.STAKE]:        ["fromTokenSymbol", "amountHuman"],
  [INTENT_ACTION.UNSTAKE]:      ["fromTokenSymbol", "amountHuman"],
  [INTENT_ACTION.CLAIM_REWARDS]: [],
};

const FIELD_PROMPTS: Partial<Record<keyof IntentPackage, string>> = {
  fromTokenSymbol: "which token to send",
  toTokenSymbol: "which token to receive",
  amountHuman: "how much",
  slippageBps: "slippage tolerance (e.g. 0.5 for 0.5%)",
  recipient: "the recipient address (0x...)",
};

// Fields on IntentPackage that can only come from the user, not from system enrichment.
// Manifest step templates that reference these fields trigger conversational collection.
const USER_PROVIDABLE_FIELDS = new Set<keyof IntentPackage>([
  "fromTokenSymbol",
  "toTokenSymbol",
  "amountHuman",
  "slippageBps",
  "recipient",
]);

// Matches {{intent.FIELD}} where FIELD has no dot (single-level, not intent.params.*)
const INTENT_TEMPLATE_RE = /\{\{intent\.([^}.]+)\}\}/g;

/**
 * Scans all string values inside manifest steps for {{intent.X}} templates.
 * Returns the subset of X values that are user-providable (not system-populated).
 */
function extractManifestRequiredFields(
  manifest: ToolManifest,
): Array<keyof IntentPackage> {
  const found = new Set<keyof IntentPackage>();

  const scanString = (s: string): void => {
    INTENT_TEMPLATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INTENT_TEMPLATE_RE.exec(s)) !== null) {
      const field = m[1].trim() as keyof IntentPackage;
      if (USER_PROVIDABLE_FIELDS.has(field)) found.add(field);
    }
  };

  const scanValue = (v: unknown): void => {
    if (typeof v === "string") scanString(v);
    else if (v !== null && typeof v === "object") {
      for (const child of Object.values(v as Record<string, unknown>)) {
        scanValue(child);
      }
    }
  };

  for (const step of manifest.steps) scanValue(step);

  return [...found];
}

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
    // Category-mapped conversational fields (fromTokenSymbol, toTokenSymbol, etc.)
    // — NOT inputSchema.required which lists solver-internal params resolved by the system.
    const categoryRequired = (REQUIRED_FIELDS[manifest.category] ?? []) as string[];
    // Any {{intent.X}} template references in manifest steps become required too,
    // so missing user-providable fields are collected conversationally before buildCalldata runs.
    const templateRequired = extractManifestRequiredFields(manifest) as string[];
    required = [...new Set([...categoryRequired, ...templateRequired])];
    console.log(
      `[validateIntent] manifest category="${manifest.category}" required=[${required.join(", ")}]` +
      (templateRequired.length ? ` (${templateRequired.join(", ")} from step templates)` : ""),
    );
  } else {
    required = (REQUIRED_FIELDS[intent.action] ?? []) as string[];
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
