import type {
  ITool,
  IToolRegistry,
} from "../../../use-cases/interface/output/tool.interface";

export class ToolRegistryConcrete implements IToolRegistry {
  private readonly tools: Map<string, ITool> = new Map();

  register(tool: ITool): void {
    this.tools.set(tool.definition().name, tool);
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  getByName(name: string): ITool | undefined {
    return this.tools.get(name);
  }
}
