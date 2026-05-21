import { InlineKeyboard } from "grammy";
import { MINI_APP_URL } from "../../../../helpers/env/telegramEnv";
import type { Artifact } from "../../../../use-cases/interface/input/capability.interface";

/**
 * Build the chat artifact that hands the user off to the mini-app via the
 * `?requestId=` URL convention (the same shape `/send` and `/swap` use through
 * the `sign_calldata` renderer). When the caller has no requestId yet — bet
 * waiting on setup, close queued behind another in-flight slot — falls back
 * to bare `MINI_APP_URL`; the FE's `useRequest` pulls the next pending sign
 * via `fetchNextRequest` once the mini-app opens.
 */
export function openMiniAppArtifact(input: {
  enqueuedRequestId: string | null;
  startedText: string;
  queuedText: string;
}): Artifact {
  const text = input.enqueuedRequestId ? input.startedText : input.queuedText;
  if (!MINI_APP_URL) {
    return { kind: "chat", text, parseMode: "Markdown" };
  }
  const url = input.enqueuedRequestId
    ? `${MINI_APP_URL}?requestId=${input.enqueuedRequestId}`
    : MINI_APP_URL;
  return {
    kind: "chat",
    text,
    parseMode: "Markdown",
    keyboard: new InlineKeyboard().webApp("Open mini app", url),
  };
}
