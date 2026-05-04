-- Seed: three stock loyalty action types (open long, open short, close).
-- SL/TP updates do not award points (no funds movement). Recovery does
-- not award points (the open failed). See:
-- be/constructions/2026-05-04-aster-stocks-impl.md P2.2.
INSERT INTO "loyalty_action_types" ("id", "display_name", "default_base", "is_active", "created_at_epoch") VALUES
  ('stock_open_long',  'Stock buy',   200, true, EXTRACT(EPOCH FROM NOW())::int),
  ('stock_open_short', 'Stock short', 200, true, EXTRACT(EPOCH FROM NOW())::int),
  ('stock_close',      'Stock close', 100, true, EXTRACT(EPOCH FROM NOW())::int)
ON CONFLICT ("id") DO NOTHING;
