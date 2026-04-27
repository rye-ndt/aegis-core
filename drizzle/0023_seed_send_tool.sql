-- Custom SQL migration file, put your code below! --
-- Seeds the ERC-20 transfer tool manifest and maps the /send command to it.
-- Idempotent: ON CONFLICT clauses make re-running safe.

INSERT INTO "tool_manifests" (
  "id",
  "tool_id",
  "category",
  "name",
  "description",
  "protocol_name",
  "tags",
  "priority",
  "is_default",
  "input_schema",
  "steps",
  "preflight_preview",
  "revenue_wallet",
  "is_verified",
  "is_active",
  "chain_ids",
  "required_fields",
  "final_schema",
  "created_at_epoch",
  "updated_at_epoch"
) VALUES (
  gen_random_uuid(),
  'transfer',
  'erc20_transfer',
  'ERC-20 Token Transfer',
  'Transfer any ERC-20 token (or native AVAX) to a recipient address on Avalanche.',
  'Native ERC-20',
  '["transfer","erc20","send","avax"]',
  10,
  true,
  '{"type":"object","required":["fromTokenSymbol","amountHuman","recipient"],"properties":{"fromTokenSymbol":{"type":"string","description":"Symbol of the token to transfer, e.g. USDC, WAVAX"},"amountHuman":{"type":"string","description":"Amount in human-readable units, e.g. \"10.5\""},"recipient":{"type":"string","description":"Recipient Ethereum address (0x...) or Telegram username (@handle)"}}}',
  '[{"kind":"erc20_transfer","name":"transfer"}]',
  '{"label":"Transfer","valueTemplate":"{{intent.amountHuman}} {{intent.fromTokenSymbol}} → {{intent.recipient}}"}',
  null,
  true,
  true,
  '[43114,43113]',
  null,
  null,
  EXTRACT(EPOCH FROM now())::integer,
  EXTRACT(EPOCH FROM now())::integer
)
ON CONFLICT ("tool_id") DO UPDATE SET
  "name"             = EXCLUDED."name",
  "description"      = EXCLUDED."description",
  "input_schema"     = EXCLUDED."input_schema",
  "steps"            = EXCLUDED."steps",
  "preflight_preview"= EXCLUDED."preflight_preview",
  "is_verified"      = EXCLUDED."is_verified",
  "is_active"        = EXCLUDED."is_active",
  "updated_at_epoch" = EXCLUDED."updated_at_epoch";
--> statement-breakpoint

INSERT INTO "command_tool_mappings" (
  "command",
  "tool_id",
  "created_at_epoch",
  "updated_at_epoch"
) VALUES (
  'send',
  'transfer',
  EXTRACT(EPOCH FROM now())::integer,
  EXTRACT(EPOCH FROM now())::integer
)
ON CONFLICT ("command") DO UPDATE SET
  "tool_id"          = EXCLUDED."tool_id",
  "updated_at_epoch" = EXCLUDED."updated_at_epoch";
