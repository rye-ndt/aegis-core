import { isAddress } from "viem";
import { INTENT_ACTION } from "../../helpers/enums/intentAction.enum";
import { TOOL_CATEGORY } from "../../helpers/enums/toolCategory.enum";
import type {
  IntentPackage,
  Address,
} from "../interface/output/intentParser.interface";
import type { ToolManifest } from "../interface/output/toolManifest.types";
import {
  MissingFieldsError,
  InvalidFieldError,
  ConversationLimitError,
  WINDOW_SIZE,
} from "../interface/input/intent.errors";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("validateIntent");

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

const USER_PROVIDABLE_FIELDS = new Set<keyof IntentPackage>([
  "fromTokenSymbol",
  "toTokenSymbol",
  "amountHuman",
  "slippageBps",
  "recipient",
]);

const INTENT_TEMPLATE_RE = /\{\{intent\.([^}.]+)\}\}/g;

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

export function validateIntent(
  intent: IntentPackage,
  messageCount: number,
  manifest?: ToolManifest,
): void {
  const atLimit = messageCount >= WINDOW_SIZE;

  let required: string[];
  if (manifest) {
    const categoryRequired = (REQUIRED_FIELDS[manifest.category] ?? []) as string[];
    const templateRequired = extractManifestRequiredFields(manifest) as string[];
    required = [...new Set([...categoryRequired, ...templateRequired])];
    log.debug({ choice: "manifest-required", category: manifest.category, required, templateRequired }, "required fields resolved");
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

  if (intent.recipient != null) {
    if (!isAddress(intent.recipient)) {
      throw new InvalidFieldError(
        "recipient",
        `"${intent.recipient}" is not a valid Ethereum address. Please provide a valid 0x... address.`,
      );
    }
    (intent as { recipient: Address }).recipient = intent.recipient as Address;
  }

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
