ALTER TABLE "conversations" ADD COLUMN "summary" text;
ALTER TABLE "conversations" ADD COLUMN "intent" text;
ALTER TABLE "conversations" ADD COLUMN "flagged_for_compression" boolean NOT NULL DEFAULT false;
ALTER TABLE "messages" ADD COLUMN "compressed_at_epoch" integer;

CREATE TABLE "evaluation_logs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "system_prompt_hash" text NOT NULL,
  "memories_injected" text NOT NULL DEFAULT '[]',
  "tool_calls" text NOT NULL DEFAULT '[]',
  "reasoning_trace" text,
  "response" text NOT NULL,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "implicit_signal" text,
  "explicit_rating" integer,
  "outcome_confirmed" boolean,
  "created_at_epoch" integer NOT NULL
);
