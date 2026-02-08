import { Agent } from './Agent';

export class TextStreamAgent extends Agent {
  private traits: string[];
  private context: string[] = [];

  constructor(name: string, model: string, guidancePrompts: string[], traits: string[]) {
    super(name, model, guidancePrompts);
    this.traits = traits;
  }

  setContext(context: string[]) {
    this.context = context;
  }

  getContext(): string[] {
    return this.context;
  }
}
