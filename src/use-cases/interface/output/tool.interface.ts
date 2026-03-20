import { TOOL_TYPE } from "../../../helpers/enums/toolType.enum";

export interface IToolInput {
  [key: string]: unknown;
}

export interface IToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface IToolDefinition {
  name: TOOL_TYPE;
  description: string;
  /** JSON Schema describing the tool's expected input */
  inputSchema: Record<string, unknown>;
}

export interface ITool {
  definition(): IToolDefinition;
  execute(input: IToolInput): Promise<IToolOutput>;
}

export interface IToolRegistry {
  register(tool: ITool): void;
  getAll(): ITool[];
  getByName(name: TOOL_TYPE): ITool | undefined;
}
