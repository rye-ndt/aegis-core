export abstract class Agent {
    private name: string;
    private model: string
    private guidancePrompts: string[]

    constructor(name: string, model: string, guidancePrompts: string[]) {
        this.name = name
        this.model = model
        this.guidancePrompts = guidancePrompts
    }

    getName(): string {
        return this.name
    }

    getModel(): string {
        return this.model
    }

    getGuidancePrompts(): string[] {
        return this.guidancePrompts
    }

    abstract stream(prompt: string): Promise<string>

    abstract response(prompt: string): Promise<string>
}