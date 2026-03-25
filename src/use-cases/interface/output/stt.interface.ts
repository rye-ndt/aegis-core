export interface ISpeechToTextInput {
  audioBuffer: Buffer;
  mimeType: string; // e.g. "audio/wav", "audio/mp3"
  languageCode?: string;
}

export interface ISpeechToTextResult {
  text: string;
  confidence?: number;
  languageDetected?: string;
}

export interface ISpeechToText {
  transcribe(input: ISpeechToTextInput): Promise<ISpeechToTextResult>;
}
