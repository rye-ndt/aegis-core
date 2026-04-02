import OpenAI, { toFile } from "openai";
import type {
  ISpeechToText,
  ISpeechToTextInput,
  ISpeechToTextResult,
} from "../../../../use-cases/interface/output/stt.interface";

export class WhisperSpeechToText implements ISpeechToText {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(input: ISpeechToTextInput): Promise<ISpeechToTextResult> {
    const file = await toFile(input.audioBuffer, "audio.ogg", {
      type: input.mimeType,
    });

    const transcription = await this.client.audio.transcriptions.create({
      model: "whisper-1",
      file,
    });

    return { text: transcription.text };
  }
}
