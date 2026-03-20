import { AssistantControllerConcrete } from "../implementations/input/http/assistant.controller";
import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { WhisperSpeechToText } from "../implementations/output/speechToText/whisper.speechToText";
import { OpenAIOrchestrator } from "../implementations/output/llmOrchestrator/openai.llmOrchestrator";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";
import { SendEmailTool } from "../implementations/output/tools/sendEmail.tool";
import { CalendarTool } from "../implementations/output/tools/calendar.tool";
import { ReminderTool } from "../implementations/output/tools/reminder.tool";
import { ToolRegistryConcrete } from "../implementations/output/toolRegistry.concrete";
import { UserInject } from "./user.di";

export class AssistantInject {
  private useCase: IAssistantUseCase | null = null;
  private ctl: AssistantControllerConcrete | null = null;
  private userInject: UserInject = new UserInject();

  getUseCase(): IAssistantUseCase {
    if (!this.useCase) {
      const speechToText = new WhisperSpeechToText(
        process.env.OPENAI_API_KEY ?? "",
      );

      const orchestrator = new OpenAIOrchestrator(
        process.env.OPENAI_API_KEY ?? "",
        process.env.OPENAI_MODEL ?? "gpt-4o",
      );

      const toolRegistry = new ToolRegistryConcrete();
      toolRegistry.register(
        new WebSearchTool(process.env.WEB_SEARCH_API_KEY ?? ""),
      );
      toolRegistry.register(new SendEmailTool(this.userInject.getEmailSender()));
      toolRegistry.register(new CalendarTool());
      toolRegistry.register(new ReminderTool());

      // TODO: wire conversationRepo and messageRepo once DB repositories are implemented
      // this.useCase = new AssistantUseCaseImpl(
      //   speechToText,
      //   orchestrator,
      //   toolRegistry,
      //   conversationRepo,
      //   messageRepo,
      // );

      throw new Error(
        "AssistantInject: conversationRepo and messageRepo not yet implemented. Wire them here.",
      );
    }
    return this.useCase;
  }

  getCtl(): AssistantControllerConcrete {
    if (!this.ctl) {
      this.ctl = new AssistantControllerConcrete(this.getUseCase());
    }
    return this.ctl;
  }
}
