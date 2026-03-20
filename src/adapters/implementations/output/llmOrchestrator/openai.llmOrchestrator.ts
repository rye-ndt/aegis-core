import type {
  ILLMOrchestrator,
  IOrchestratorInput,
  IOrchestratorResponse,
} from "../../../../use-cases/interface/output/llmOrchestrator.interface";

// TODO: implement using OpenAI chat completions with tool_use / function calling
export class OpenAIOrchestrator implements ILLMOrchestrator {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(_input: IOrchestratorInput): Promise<IOrchestratorResponse> {
    throw new Error("OpenAIOrchestrator.chat() not yet implemented");
  }
}
