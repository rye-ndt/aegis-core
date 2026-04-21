import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { encryptValue } from "../../helpers/crypto/aes";
import type { IHttpQueryToolDB } from "../interface/output/repository/httpQueryTool.repo";
import type {
  IHttpQueryToolUseCase,
  IRegisterHttpQueryToolInput,
  IListHttpQueryToolsOutput,
} from "../interface/input/httpQueryTool.interface";

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_NAMES = new Set(["web_search", "execute_intent", "get_portfolio"]);

export class HttpQueryToolUseCaseImpl implements IHttpQueryToolUseCase {
  constructor(
    private readonly db: IHttpQueryToolDB,
    private readonly encryptionKey?: string,
  ) {}

  async register(input: IRegisterHttpQueryToolInput): Promise<{ id: string; name: string }> {
    if (!TOOL_NAME_RE.test(input.name)) {
      throw new Error("INVALID_TOOL_NAME: must be snake_case, start with a letter, max 63 chars");
    }
    if (RESERVED_NAMES.has(input.name)) {
      throw new Error(`INVALID_TOOL_NAME: "${input.name}" is a reserved system tool name`);
    }
    try {
      new URL(input.endpoint);
    } catch {
      throw new Error("INVALID_ENDPOINT_URL");
    }

    const hasEncryptedHeaders = input.headers.some((h) => h.encrypt);
    if (hasEncryptedHeaders && !this.encryptionKey) {
      throw new Error("ENCRYPTION_KEY_NOT_CONFIGURED");
    }

    const id = newUuid();
    const now = newCurrentUTCEpoch();

    await this.db.create({
      id,
      userId: input.userId,
      name: input.name,
      description: input.description,
      endpoint: input.endpoint,
      method: input.method,
      requestBodySchema: JSON.stringify(input.requestBodySchema),
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    if (input.headers.length > 0) {
      await this.db.createHeaders(
        input.headers.map((h) => ({
          id: newUuid(),
          toolId: id,
          headerKey: h.key,
          headerValue: h.encrypt ? encryptValue(h.value, this.encryptionKey!) : h.value,
          isEncrypted: h.encrypt,
          createdAtEpoch: now,
        })),
      );
    }

    return { id, name: input.name };
  }

  async list(userId: string): Promise<IListHttpQueryToolsOutput[]> {
    const tools = await this.db.findActiveByUser(userId);
    return Promise.all(
      tools.map(async (t) => {
        const headers = await this.db.getHeaders(t.id);
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          endpoint: t.endpoint,
          method: t.method,
          requestBodySchema: JSON.parse(t.requestBodySchema) as Record<string, unknown>,
          headers: headers.map((h) => ({ key: h.headerKey, isEncrypted: h.isEncrypted })),
          createdAtEpoch: t.createdAtEpoch,
        };
      }),
    );
  }

  async deactivate(id: string, userId: string): Promise<void> {
    const tool = await this.db.findById(id);
    if (!tool) throw new Error("TOOL_NOT_FOUND");
    if (tool.userId !== userId) throw new Error("TOOL_FORBIDDEN");
    await this.db.deactivate(id, userId);
  }
}
