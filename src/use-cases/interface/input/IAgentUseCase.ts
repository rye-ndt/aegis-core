export interface IAgentResponse {
  text: string;
  toolCalled: string[];
}

export interface IAgentRequest {
  prompt: string;
  sessionID: string;
}

export interface IAgentUseCase {
  streamResponse(request: IAgentRequest): Promise<IAgentResponse>;
}
