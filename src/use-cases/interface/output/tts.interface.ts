export interface ITTSInput {
  text: string;
  voice?: string;
}

export interface ITTSOutput {
  audioBuffer: Buffer;
  mimeType: string;
}

export interface ITextToSpeech {
  synthesize(input: ITTSInput): Promise<ITTSOutput>;
}
