import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { INTENT_STATUSES } from "../../helpers/enums/intentStatus.enum";
import { INTENT_ACTION } from "../../helpers/enums/intentAction.enum";
import { EXECUTION_STATUSES } from "../../helpers/enums/executionStatus.enum";
import type {
  IIntentUseCase,
  IntentExecutionResult,
} from "../interface/input/intent.interface";
import type { IntentPackage } from "../interface/output/intentParser.interface";
import type { IIntentParser } from "../interface/output/intentParser.interface";
import type { ITokenRegistryService } from "../interface/output/tokenRegistry.interface";
import type { ISolverRegistry } from "../interface/output/solver/solverRegistry.interface";
import type { IUserOperationBuilder } from "../interface/output/blockchain/userOperation.interface";
import type { ISimulator } from "../interface/output/simulator.interface";
import type { IIntentDB } from "../interface/output/repository/intent.repo";
import type { IIntentExecutionDB } from "../interface/output/repository/intentExecution.repo";
import type { IFeeRecordDB } from "../interface/output/repository/feeRecord.repo";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IMessageDB } from "../interface/output/repository/message.repo";
import { MESSAGE_ROLE } from "../../helpers/enums/messageRole.enum";
import type { IResultParser } from "../../adapters/implementations/output/resultParser/tx.resultParser";
import {
  MissingFieldsError,
  ConversationLimitError,
  InvalidFieldError,
  validateIntent,
} from "../../adapters/implementations/output/intentParser/intent.validator";

const CONFIDENCE_THRESHOLD = 0.7;
const PLATFORM_FEE_BPS = 80;
const CONTRIBUTOR_FEE_BPS = 20;
const TOTAL_FEE_BPS = 100;

export class IntentUseCaseImpl implements IIntentUseCase {
  constructor(
    private readonly intentParser: IIntentParser,
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly solverRegistry: ISolverRegistry,
    private readonly userOpBuilder: IUserOperationBuilder,
    private readonly simulator: ISimulator,
    private readonly intentDB: IIntentDB,
    private readonly intentExecutionDB: IIntentExecutionDB,
    private readonly feeRecordDB: IFeeRecordDB,
    private readonly userProfileDB: IUserProfileDB,
    private readonly messageDB: IMessageDB,
    private readonly resultParser: IResultParser,
    private readonly chainId: number,
    private readonly treasuryAddress: string,
  ) {}

  async parseAndExecute(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    rawInput: string;
  }): Promise<IntentExecutionResult> {
    const now = newCurrentUTCEpoch();
    const intentId = newUuid();

    // 1. Build sliding window of last 10 user messages for this conversation.
    //    Fetch up to 9 prior user messages and append the current rawInput.
    const priorMessages = await this.messageDB.findByConversationId(
      params.conversationId,
    );
    const priorUserContent = priorMessages
      .filter((m) => m.role === MESSAGE_ROLE.USER)
      .slice(-9)
      .map((m) => m.content);
    const messages = [...priorUserContent, params.rawInput];

    // 2. Parse then validate intent
    let intent: IntentPackage | null;
    try {
      intent = await this.intentParser.parse(messages, params.userId);
      if (intent !== null) validateIntent(intent, messages.length);
    } catch (err) {
      if (err instanceof ConversationLimitError) {
        // Reset conversation messages so the user starts fresh
        await this.messageDB.deleteByConversationId(params.conversationId);
        return {
          intentId,
          status: INTENT_STATUSES.REJECTED,
          humanSummary:
            err.message +
            "\n\nYour conversation has been reset. Please send a new complete request.",
          requiresConfirmation: false,
        };
      }
      if (
        err instanceof MissingFieldsError ||
        err instanceof InvalidFieldError
      ) {
        return {
          intentId,
          status: INTENT_STATUSES.REJECTED,
          humanSummary: err.prompt,
          requiresConfirmation: false,
        };
      }
      throw err;
    }

    // Handle no onchain intent
    if (intent === null) {
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: "No on-chain action detected in your message.",
        requiresConfirmation: false,
      };
    }

    // 3. Confidence check
    if (
      intent.confidence < CONFIDENCE_THRESHOLD ||
      intent.action === INTENT_ACTION.UNKNOWN
    ) {
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.REJECTED,
        rejectionReason: "Low confidence or unrecognized intent",
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `I couldn't understand that intent clearly (confidence: ${Math.round(intent.confidence * 100)}%). Could you rephrase? For example: "Swap 100 USDC for AVAX" or "Claim my rewards".`,
        requiresConfirmation: false,
      };
    }

    // 4. Get solver
    const solver = this.solverRegistry.getSolver(intent.action);
    if (!solver) {
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.REJECTED,
        rejectionReason: `No solver for action: ${intent.action}`,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `This action (${intent.action}) is not yet supported. Supported actions: swap, claim_rewards.`,
        requiresConfirmation: false,
      };
    }

    // 5. Get user's SCA address
    const profile = await this.userProfileDB.findByUserId(params.userId);
    const smartAccountAddress = profile?.smartAccountAddress ?? params.userId;

    // 6. Build calldata
    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await solver.buildCalldata(intent, smartAccountAddress);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.REJECTED,
        rejectionReason: reason,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: `Couldn't build transaction: ${reason}`,
        requiresConfirmation: false,
      };
    }

    // 7. Build UserOperation (unsigned)
    const userOp = await this.userOpBuilder.build({
      smartAccountAddress,
      callData: calldata.data,
      sessionKey: { privateKey: "", address: "" }, // populated by builder from env
    });

    // 8. Simulate
    const simulationReport = await this.simulator.simulate({
      userOp,
      intent,
      chainId: this.chainId,
    });

    if (!simulationReport.passed) {
      await this.intentDB.create({
        id: intentId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        rawInput: params.rawInput,
        parsedJson: JSON.stringify(intent),
        status: INTENT_STATUSES.SIMULATION_FAILED,
        rejectionReason: simulationReport.warnings.join("; "),
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
      return {
        intentId,
        status: INTENT_STATUSES.SIMULATION_FAILED,
        simulationReport,
        humanSummary: `Pre-flight simulation failed:\n${simulationReport.warnings.join("\n")}`,
        requiresConfirmation: false,
      };
    }

    // 9. Save as awaiting confirmation
    await this.intentDB.create({
      id: intentId,
      userId: params.userId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      rawInput: params.rawInput,
      parsedJson: JSON.stringify(intent),
      status: INTENT_STATUSES.AWAITING_CONFIRMATION,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    const humanSummary = this.buildPreFlightSummary(intent, simulationReport);
    return {
      intentId,
      status: INTENT_STATUSES.AWAITING_CONFIRMATION,
      simulationReport,
      humanSummary,
      requiresConfirmation: true,
    };
  }

  async confirmAndExecute(params: {
    intentId: string;
    userId: string;
  }): Promise<IntentExecutionResult> {
    const now = newCurrentUTCEpoch();

    // Support "__latest__" sentinel — find the most recent awaiting confirmation intent
    let intent =
      params.intentId === "__latest__"
        ? await this.intentDB.findPendingByUserId(params.userId)
        : await this.intentDB.findById(params.intentId);

    if (!intent || intent.userId !== params.userId) {
      return {
        intentId: params.intentId,
        status: INTENT_STATUSES.REJECTED,
        humanSummary: "No pending intent found. Send a trading request first.",
        requiresConfirmation: false,
      };
    }
    if (intent.status !== INTENT_STATUSES.AWAITING_CONFIRMATION) {
      return {
        intentId: params.intentId,
        status: intent.status,
        humanSummary: `This intent is already in status: ${intent.status}`,
        requiresConfirmation: false,
      };
    }

    const intentPackage: IntentPackage = JSON.parse(intent.parsedJson);
    const profile = await this.userProfileDB.findByUserId(params.userId);
    const smartAccountAddress = profile?.smartAccountAddress ?? params.userId;

    const solver = this.solverRegistry.getSolver(intentPackage.action);
    if (!solver) {
      await this.intentDB.updateStatus(
        params.intentId,
        INTENT_STATUSES.FAILED,
        "No solver available",
      );
      return {
        intentId: params.intentId,
        status: INTENT_STATUSES.FAILED,
        humanSummary: "Execution failed: no solver available.",
        requiresConfirmation: false,
      };
    }

    await this.intentDB.updateStatus(
      params.intentId,
      INTENT_STATUSES.EXECUTING,
    );
    const executionId = newUuid();

    try {
      const calldata = await solver.buildCalldata(
        intentPackage,
        smartAccountAddress,
      );
      const userOp = await this.userOpBuilder.build({
        smartAccountAddress,
        callData: calldata.data,
        sessionKey: { privateKey: "", address: "" },
      });

      const simulationReport = await this.simulator.simulate({
        userOp,
        intent: intentPackage,
        chainId: this.chainId,
      });

      await this.intentExecutionDB.create({
        id: executionId,
        intentId: params.intentId,
        userId: params.userId,
        smartAccountAddress,
        solverUsed: solver.name,
        simulationPassed: simulationReport.passed,
        simulationResult: JSON.stringify(simulationReport),
        status: EXECUTION_STATUSES.SUBMITTING,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });

      const { userOpHash } = await this.userOpBuilder.submit(userOp);
      await this.intentExecutionDB.update(executionId, {
        userOpHash,
        status: EXECUTION_STATUSES.SUBMITTED,
        updatedAtEpoch: newCurrentUTCEpoch(),
      });

      const { txHash, success } =
        await this.userOpBuilder.waitForReceipt(userOpHash);
      const finalStatus = success
        ? EXECUTION_STATUSES.CONFIRMED
        : EXECUTION_STATUSES.FAILED;

      await this.intentExecutionDB.update(executionId, {
        txHash,
        status: finalStatus,
        updatedAtEpoch: newCurrentUTCEpoch(),
      });

      if (success) {
        await this.feeRecordDB.create({
          id: newUuid(),
          executionId,
          userId: params.userId,
          totalFeeBps: TOTAL_FEE_BPS,
          platformFeeBps: PLATFORM_FEE_BPS,
          contributorFeeBps: CONTRIBUTOR_FEE_BPS,
          feeTokenAddress: "0x", // TODO: set from resolved tokenIn after token resolution step
          feeAmountRaw: "0",
          platformAddress: this.treasuryAddress,
          txHash,
          chainId: this.chainId,
          createdAtEpoch: newCurrentUTCEpoch(),
        });
      }

      await this.intentDB.updateStatus(
        params.intentId,
        success ? INTENT_STATUSES.COMPLETED : INTENT_STATUSES.FAILED,
      );

      const humanSummary = await this.resultParser.parse({
        txHash,
        intent: intentPackage,
        chainId: this.chainId,
      });

      return {
        intentId: params.intentId,
        status: success ? INTENT_STATUSES.COMPLETED : INTENT_STATUSES.FAILED,
        humanSummary,
        requiresConfirmation: false,
        executionId,
        txHash,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.intentDB.updateStatus(
        params.intentId,
        INTENT_STATUSES.FAILED,
        errorMessage,
      );
      await this.intentExecutionDB
        .update(executionId, {
          status: EXECUTION_STATUSES.FAILED,
          errorMessage,
          updatedAtEpoch: newCurrentUTCEpoch(),
        })
        .catch(() => {});
      return {
        intentId: params.intentId,
        status: INTENT_STATUSES.FAILED,
        humanSummary: `Execution failed: ${errorMessage}`,
        requiresConfirmation: false,
        executionId,
      };
    }
  }

  async getHistory(userId: string): Promise<IntentPackage[]> {
    const intents = await this.intentDB.listByUserId(userId, 20);
    return intents.map((i) => {
      try {
        return JSON.parse(i.parsedJson) as IntentPackage;
      } catch {
        return {
          action: INTENT_ACTION.UNKNOWN,
          confidence: 0,
          rawInput: i.rawInput,
        };
      }
    });
  }

  private buildPreFlightSummary(
    intent: IntentPackage,
    sim: { gasEstimate: string; warnings: string[] },
  ): string {
    const lines: string[] = ["⚡ Pre-Flight Check", ""];

    const actionLabel = {
      [INTENT_ACTION.SWAP]: "Swap",
      [INTENT_ACTION.STAKE]: "Stake",
      [INTENT_ACTION.UNSTAKE]: "Unstake",
      [INTENT_ACTION.CLAIM_REWARDS]: "Claim Rewards",
      [INTENT_ACTION.TRANSFER]: "Transfer",
      [INTENT_ACTION.UNKNOWN]: "Unknown",
    }[intent.action];
    lines.push(`Action: ${actionLabel}`);

    // TODO: restore token details after token resolution step is added
    if (intent.fromTokenSymbol) {
      lines.push(
        `You send: ${intent.amountHuman ?? "?"} ${intent.fromTokenSymbol}`,
      );
    }
    if (intent.toTokenSymbol) {
      lines.push(`You receive: ~? ${intent.toTokenSymbol} (est.)`);
    }
    if (intent.slippageBps) {
      lines.push(`Slippage: ${intent.slippageBps / 100}%`);
    }
    lines.push(`Protocol fee: 1%`);
    lines.push(
      `Gas estimate: ${parseInt(sim.gasEstimate).toLocaleString()} units`,
    );
    lines.push("");
    lines.push("Simulation: ✅ PASSED");
    if (sim.warnings.length > 0) {
      lines.push(`Warnings: ${sim.warnings.join(", ")}`);
    }
    lines.push("");
    lines.push("Type /confirm to execute or /cancel to abort.");

    return lines.join("\n");
  }
}
