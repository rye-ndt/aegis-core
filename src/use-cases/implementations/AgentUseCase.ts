import { TextStreamAgent } from '../../core/entities/TextStreamAgent';
import { ToolcallAgent } from '../../core/entities/ToolcallAgent';
import { IAgentRequest, IAgentResponse, IAgentUseCase } from '../interface/input/IAgentUseCase';

export class AgentUseCaseConcrete implements IAgentUseCase {
  private TextAgent: TextStreamAgent;
  private ToolAgent: ToolcallAgent;

  constructor(textAgent: TextStreamAgent, toolAgent: ToolcallAgent) {
    this.TextAgent = textAgent;
    this.ToolAgent = toolAgent;
  }

  streamResponse(request: IAgentRequest): Promise<IAgentResponse> {
    //memory extract from redis
    //decide if tool call needed
    //call text model
  }
}
