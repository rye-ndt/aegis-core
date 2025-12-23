import { Agent } from "./Agent";

export class TextStreamAgent extends Agent {
    private traits: string[]

    constructor(name: string, model: string, guidancePrompts: string[], traits: string[]) {
        super(name, model, guidancePrompts)
        this.traits = traits
    }

    async stream(prompt: string): Promise<string> {
        return ""
    }

    async response(prompt: string): Promise<string> {
        return ""
    }
}