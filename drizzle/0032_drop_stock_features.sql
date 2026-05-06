-- Teardown for the removed Aster (tokenized stocks) capability.
-- Idempotent: safe to run on fresh DBs (where 0027/0029 never existed)
-- and on DBs that already applied them.

DROP TABLE IF EXISTS "stock_pairs";

DELETE FROM "loyalty_action_types"
WHERE "id" IN ('stock_open_long', 'stock_open_short', 'stock_close');
