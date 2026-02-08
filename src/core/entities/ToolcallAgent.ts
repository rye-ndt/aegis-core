import { Agent } from './Agent';

export interface Tool {
  name: string;
  description: string;
  responseSchema: any;
}

export class ToolcallAgent extends Agent {
  private toolList: Tool[]; //search, generate image, store memory

  constructor(name: string, model: string, guidancePrompts: string[], toolList: Tool[]) {
    super(name, model, guidancePrompts);
    this.toolList = toolList;
  }
}
