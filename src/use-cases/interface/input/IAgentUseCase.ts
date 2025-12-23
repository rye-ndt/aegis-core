export interface IAgentUseCase {
    streamResponse(prompt: string): Promise<string>
}