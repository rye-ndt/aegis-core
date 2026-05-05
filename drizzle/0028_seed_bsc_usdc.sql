-- Seed: Binance-Peg USD Coin (USDC) on BNB Smart Chain (chain 56).
-- Required by AsterBrokerProvider.create(), which looks up the collateral
-- token via tokenRegistry.findByAddressAndChain(BSC_USDC, 56). Without this
-- row the broker provider throws at boot, StockCapability is never registered,
-- and /stock commands fall through to AssistantChatCapability.
--
-- Decimals: 18. BSC's Binance-Peg USDC has 18 decimals, not 6.
-- Address:  must match BSC_USDC env var (0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d).
INSERT INTO "token_registry"
  ("id", "symbol", "name", "chain_id", "address", "decimals",
   "is_native", "is_verified", "logo_uri", "deployer_address",
   "created_at_epoch", "updated_at_epoch")
VALUES
  (
    gen_random_uuid(),
    'USDC',
    'Binance-Peg USD Coin',
    56,
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    18,
    false,
    true,
    null,
    null,
    EXTRACT(EPOCH FROM NOW())::int,
    EXTRACT(EPOCH FROM NOW())::int
  )
ON CONFLICT ("symbol", "chain_id") DO NOTHING;
