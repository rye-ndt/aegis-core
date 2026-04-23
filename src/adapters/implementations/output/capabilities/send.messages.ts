import { toRaw } from "../../../../helpers/bigint";
import { ZERODEV_MESSAGE_TYPE } from "../../../../helpers/enums/zerodevMessageType.enum";
import type { ITokenRecord, ResolvedPayload, ToolManifest } from "../../../../use-cases/interface/input/intent.interface";
import type { ZerodevMessage } from "../../../../use-cases/interface/output/delegation/zerodevMessage.types";

interface ConfirmationTarget {
  manifest: ToolManifest;
  partialParams: Record<string, unknown>;
}

export function buildDelegationPrompt(msg: ZerodevMessage): string {
  if (msg.type === ZERODEV_MESSAGE_TYPE.ERC20_SPEND) {
    const expiresDate = new Date(msg.validUntil * 1000).toISOString().split("T")[0];
    return [
      "🔐 *Delegation Request*",
      "",
      "The bot is requesting permission to spend tokens on your behalf.",
      `Token: \`${msg.target}\``,
      `Max amount: ${msg.valueLimit} (raw)`,
      `Expires: ${expiresDate}`,
      "",
      "Open the Aegis app to approve or dismiss this request.",
    ].join("\n");
  }
  return "🔐 Delegation request pending. Open the Aegis app to review.";
}

export function buildConfirmationMessage(
  session: ConfirmationTarget,
  calldata: { to: string; data: string; value: string },
  fromToken: ITokenRecord | null,
  toToken: ITokenRecord | null,
): string {
  const { manifest, partialParams } = session;
  const lines = ["*Intent confirmed*", ""];

  lines.push(`Action: ${manifest.name}`);
  lines.push(`Protocol: ${manifest.protocolName}`);

  if (fromToken) {
    lines.push(`From: ${fromToken.symbol} (${fromToken.name})`);
    lines.push(`  Address: \`${fromToken.address}\``);
    lines.push(`  Decimals: ${fromToken.decimals}`);
    const amountHuman = partialParams.amountHuman as string | undefined;
    if (amountHuman) {
      const raw = toRaw(amountHuman, fromToken.decimals);
      lines.push(`  Amount: ${amountHuman} ${fromToken.symbol} (${raw} raw)`);
    }
  }

  if (toToken) {
    lines.push(`To: ${toToken.symbol} (${toToken.name})`);
    lines.push(`  Address: \`${toToken.address}\``);
    lines.push(`  Decimals: ${toToken.decimals}`);
  }

  lines.push("", "*Calldata*");
  lines.push(`To: \`${calldata.to}\``);
  lines.push(`Value: ${calldata.value}`);
  lines.push(`\`\`\`\n${calldata.data}\n\`\`\``);
  lines.push("", `\`\`\`json\n${JSON.stringify(partialParams, null, 2)}\n\`\`\``);
  lines.push("", "Open the Aegis app to review and sign this transaction.");

  return lines.join("\n");
}

export function buildDisambiguationPrompt(
  slot: "from" | "to",
  symbol: string,
  candidates: ITokenRecord[],
): string {
  const label = slot === "from" ? "source token" : "destination token";
  const lines = [`Multiple tokens found for "${symbol}" (${label}). Which one do you mean?`, ""];
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i]!;
    const addr = t.address.slice(0, 6) + "..." + t.address.slice(-4);
    lines.push(`${i + 1}. ${t.symbol} — ${t.name} — ${addr} (${t.decimals} decimals)`);
  }
  lines.push("", "Reply with the number.");
  return lines.join("\n");
}

export function populateFinalSchema(
  finalSchema: Record<string, unknown>,
  resolved: ResolvedPayload,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  const properties = (finalSchema.properties ?? {}) as Record<string, { description?: string }>;
  for (const key of Object.keys(properties)) {
    if (key === "from_token_address" && resolved.fromToken) filled[key] = resolved.fromToken.address;
    else if (key === "to_token_address" && resolved.toToken) filled[key] = resolved.toToken.address;
    else if (key === "raw_amount" && resolved.rawAmount) filled[key] = resolved.rawAmount;
    else if (key === "recipient_address" && resolved.recipientAddress) filled[key] = resolved.recipientAddress;
    else if (key === "sender_address" && resolved.senderAddress) filled[key] = resolved.senderAddress;
    else if (params[key] !== undefined) filled[key] = params[key];
  }
  return filled;
}

export function buildFinalSchemaConfirmation(
  session: ConfirmationTarget,
  finalSchema: Record<string, unknown>,
  calldata: { to: string; data: string; value: string },
): string {
  return [
    "*Transaction Preview*",
    "",
    `Action: ${session.manifest.name}`,
    `Protocol: ${session.manifest.protocolName}`,
    "",
    "*Resolved Parameters:*",
    "```json",
    JSON.stringify(finalSchema, null, 2),
    "```",
    "",
    "*Calldata*",
    `To: \`${calldata.to}\``,
    `Value: ${calldata.value}`,
    `\`\`\`\n${calldata.data}\n\`\`\``,
    "",
    "Open the Aegis app to review and sign this transaction.",
  ].join("\n");
}
