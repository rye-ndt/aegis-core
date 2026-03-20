import { TOOL_TYPE } from "../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolRegistry,
} from "../../../use-cases/interface/output/tool.interface";

export class ToolRegistryConcrete implements IToolRegistry {
  private readonly tools: Map<TOOL_TYPE, ITool> = new Map();

  register(tool: ITool): void {
    this.tools.set(tool.definition().name, tool);
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  getByName(name: TOOL_TYPE): ITool | undefined {
    return this.tools.get(name);
  }
}
