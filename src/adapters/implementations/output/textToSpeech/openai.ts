import OpenAI from "openai";
import type {
  ITextToSpeech,
  ITTSInput,
  ITTSOutput,
} from "../../../../use-cases/interface/output/tts.interface";

export class OpenAITTS implements ITextToSpeech {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async synthesize(input: ITTSInput): Promise<ITTSOutput> {
    const response = await this.client.audio.speech.create({
      model: "tts-1",
      voice: (input.voice as "alloy") ?? "alloy",
      input: input.text,
      response_format: "opus",
    });

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return { audioBuffer, mimeType: "audio/ogg; codecs=opus" };
  }
}
