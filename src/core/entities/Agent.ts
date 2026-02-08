import { SUPPORTED_FUNCTIONS } from '../../helpers/enums/supportedFunctions.enum';

export abstract class Agent {
  private name: string;
  private model: string;
  private guidancePrompts: string[];
  private supportedMethod: SUPPORTED_FUNCTIONS[];
  private memories: string[] = [];

  constructor(name: string, model: string, guidancePrompts: string[], supportedMethods: SUPPORTED_FUNCTIONS[]) {
    this.name = name;
    this.model = model;
    this.guidancePrompts = guidancePrompts;
    this.supportedMethod = supportedMethods;
  }

  getName(): string {
    return this.name;
  }

  getModel(): string {
    return this.model;
  }

  getGuidancePrompts(): string[] {
    return this.guidancePrompts;
  }

  setMemories(memories: string[]) {
    this.memories = memories;
  }

  getSupportedMethod(): SUPPORTED_FUNCTIONS[] {
    return this.supportedMethod;
  }

  getMemories(): string[] {
    return this.memories;
  }
}
