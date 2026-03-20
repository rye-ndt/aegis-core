import type {
  ISpeechToText,
  ISpeechToTextInput,
  ISpeechToTextResult,
} from "../../../../use-cases/interface/output/speechToText.interface";

// TODO: implement using OpenAI Whisper API or a local Whisper model
export class WhisperSpeechToText implements ISpeechToText {
  constructor(private readonly apiKey: string) {}

  async transcribe(_input: ISpeechToTextInput): Promise<ISpeechToTextResult> {
    throw new Error("WhisperSpeechToText.transcribe() not yet implemented");
  }
}
