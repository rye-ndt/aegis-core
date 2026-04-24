import { encodeFunctionData } from "viem";
import type { ToolStep } from "../../../../../use-cases/interface/output/toolManifest.types";
import { resolve, resolveRecord, type TemplateContext } from "./templateEngine";
import { createLogger } from "../../../../../helpers/observability/logger";

const log = createLogger("stepExecutors");
export type { TemplateContext };

type StepOutput = Record<string, string>;

// JSONPath resolver — supports $.field, $.nested.field, and $.arr[0].field
function jsonPathGet(data: unknown, path: string): string {
  if (!path.startsWith("$.")) throw new Error(`Unsupported JSONPath: "${path}"`);
  const parts = path.slice(2).split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      throw new Error(`JSONPath "${path}" not found in response`);
    }
    const arrayMatch = part.match(/^(.+?)\[(\d+)\]$/);
    if (arrayMatch) {
      current = (current as Record<string, unknown>)[arrayMatch[1]];
      if (!Array.isArray(current)) throw new Error(`JSONPath "${path}": "${arrayMatch[1]}" is not an array`);
      current = current[parseInt(arrayMatch[2], 10)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  if (current == null) throw new Error(`JSONPath "${path}" resolved to null`);
  return String(current);
}

function applyExtract(data: unknown, extract: Record<string, string>): StepOutput {
  const result: StepOutput = {};
  for (const [key, path] of Object.entries(extract)) {
    result[key] = jsonPathGet(data, path);
  }
  return result;
}

export async function executeHttpGet(
  step: Extract<ToolStep, { kind: "http_get" }>,
  ctx: TemplateContext,
): Promise<StepOutput> {
  const url = resolve(step.url, ctx);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP GET ${url} failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
  }
  const data: unknown = await response.json();
  return applyExtract(data, step.extract);
}

export async function executeHttpPost(
  step: Extract<ToolStep, { kind: "http_post" }>,
  ctx: TemplateContext,
): Promise<StepOutput> {
  const url = resolve(step.url, ctx);
  const resolvedBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step.body)) {
    resolvedBody[key] = typeof value === "string" ? resolve(value, ctx) : value;
  }
  log.debug({ step: "http_post", url, body: resolvedBody }, "executing HTTP post step");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resolvedBody),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP POST ${url} failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
  }
  const data: unknown = await response.json();
  return applyExtract(data, step.extract);
}

export async function executeAbiEncode(
  step: Extract<ToolStep, { kind: "abi_encode" }>,
  ctx: TemplateContext,
): Promise<StepOutput> {
  const resolvedParams = resolveRecord(step.paramMapping, ctx);
  const args = step.abiFragment.inputs.map((input) => {
    const val = resolvedParams[input.name];
    if (val === undefined) {
      throw new Error(`ABI encode step "${step.name}": missing param "${input.name}"`);
    }
    return val;
  });
  const data = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: step.abiFragment.name,
        inputs: step.abiFragment.inputs,
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
    functionName: step.abiFragment.name,
    args,
  });
  return { to: step.contractAddress, data, value: "0" };
}

export async function executeCalldataPassthrough(
  step: Extract<ToolStep, { kind: "calldata_passthrough" }>,
  ctx: TemplateContext,
): Promise<StepOutput> {
  return {
    to:    resolve(step.to, ctx),
    data:  resolve(step.data, ctx),
    value: resolve(step.value, ctx),
  };
}

export async function executeErc20Transfer(
  _step: Extract<ToolStep, { kind: "erc20_transfer" }>,
  ctx: TemplateContext,
): Promise<StepOutput> {
  const params = ctx.intent.params ?? {};
  const tokenAddress = params["tokenAddress"] as string | undefined;
  const amountRaw    = params["amountRaw"]    as string | undefined;
  const recipient    = ctx.intent.recipient;

  if (!tokenAddress) throw new Error("erc20_transfer step: missing intent.params.tokenAddress");
  if (!amountRaw)    throw new Error("erc20_transfer step: missing intent.params.amountRaw");
  if (!recipient)    throw new Error("erc20_transfer step: missing intent.recipient");

  const data = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        inputs: [
          { name: "to",     type: "address" },
          { name: "value",  type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "transfer",
    args: [recipient, BigInt(amountRaw)],
  });
  return { to: tokenAddress, data, value: "0" };
}

export const STEP_EXECUTORS: {
  [K in ToolStep["kind"]]: (
    step: Extract<ToolStep, { kind: K }>,
    ctx: TemplateContext,
  ) => Promise<StepOutput>;
} = {
  http_get:             executeHttpGet,
  http_post:            executeHttpPost,
  abi_encode:           executeAbiEncode,
  calldata_passthrough: executeCalldataPassthrough,
  erc20_transfer:       executeErc20Transfer,
};
