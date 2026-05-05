import type {
  IntentResult,
  IntentVerb,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("buildPreview");

export interface BuildPreviewInput {
  verb: IntentVerb;
  /** Imperative/present tense, e.g. "Swap 5 USDC for AVAX". */
  headline: string;
  fields: ResultField[];
  details?: ResultField[];
  /** Correlation id for support; logged but never user-visible on previews. */
  requestId?: string;
}

/**
 * Standard constructor for `Artifact.sign_calldata.preview`. Capabilities
 * call this once per sign request so the mini-app's existing approve modal
 * can render a clean human-readable summary instead of raw to/value/calldata.
 *
 * Always `status: "preview"`. Never carries `txHashes` or `nextActions` —
 * the modal owns its own approve/reject footer.
 */
export function buildPreview(input: BuildPreviewInput): IntentResult {
  log.debug(
    { verb: input.verb, requestId: input.requestId },
    "preview-attached",
  );
  return {
    status: "preview",
    verb: input.verb,
    headline: input.headline,
    fields: input.fields,
    details: input.details,
    requestId: input.requestId,
  };
}
