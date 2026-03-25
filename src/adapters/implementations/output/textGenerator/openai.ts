import OpenAI from "openai";
import type { ITextGenerator } from "../../../../use-cases/interface/output/textGenerator.interface";

export class OpenAITextGenerator implements ITextGenerator {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return response.choices[0].message.content ?? "";
  }
}
