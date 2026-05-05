import type {
  IntentVerb,
  ResultField,
  ResultStatus,
} from "../input/resultCard.types";

export interface InterpreterInput {
  verb: IntentVerb;
  status: ResultStatus;
  /** Already-formatted body fields. The interpreter must not introduce numbers not present here. */
  fields: ResultField[];
  interpreterContext?: Record<string, unknown>;
}

export interface IIntentInterpreter {
  /** Returns a single ≤25-word italic-ready sentence, or null on failure/timeout. */
  interpret(input: InterpreterInput): Promise<string | null>;
}
