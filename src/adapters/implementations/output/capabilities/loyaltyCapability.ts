import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import type {
  IntentResult,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import type { LedgerEntry } from "../../../../use-cases/interface/output/repository/loyalty.repo";

const log = createLogger("loyaltyCapability");

export interface LoyaltyCapabilityDeps {
  loyaltyUseCase: ILoyaltyUseCase;
  leaderboardDefaultLimit: number;
}

// TODO(i18n): English-only labels.
const ACTION_LABELS: Record<string, string> = {
  swap_same_chain: "Swap (same-chain)",
  swap_cross_chain: "Swap (cross-chain)",
  send_erc20: "Send",
  send_native: "Send (native)",
  yield_deposit: "Yield deposit",
  yield_hold_day: "Yield hold",
  referral: "Referral",
  manual_adjust: "Adjustment",
  stock_open_long: "Stock buy",
  stock_open_short: "Stock short",
  stock_close: "Stock close",
};

const MAX_HISTORY_FIELDS = 4;
const MAX_LEADERBOARD_FIELDS = 5;

function formatRelativeTime(epochSeconds: number): string {
  const diffSeconds = newCurrentUTCEpoch() - epochSeconds;
  if (diffSeconds < 60) return "just now";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 172800) return "yesterday";
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

function formatPoints(p: bigint): string {
  return p.toLocaleString("en-US");
}

function formatActionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}

function shortUserId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function buildHistoryEntry(entry: LedgerEntry): ResultField {
  const sign = entry.pointsRaw >= 0n ? "+" : "";
  return {
    label: formatActionLabel(entry.actionType),
    value: `${sign}${formatPoints(entry.pointsRaw)} pts · ${formatRelativeTime(entry.createdAtEpoch)}`,
  };
}

export class LoyaltyCapability implements Capability<void> {
  readonly id = "intent_loyalty";
  readonly triggers: TriggerSpec = {
    commands: [INTENT_COMMAND.POINTS, INTENT_COMMAND.LEADERBOARD],
  };

  constructor(private readonly deps: LoyaltyCapabilityDeps) {}

  async collect(_ctx: CapabilityCtx): Promise<CollectResult<void>> {
    return { kind: "ok", params: undefined };
  }

  async run(_params: void, ctx: CapabilityCtx): Promise<Artifact> {
    const command =
      ctx.input.kind === "text"
        ? ctx.input.text.trim().split(/\s+/)[0]?.toLowerCase()
        : undefined;

    if (command === INTENT_COMMAND.LEADERBOARD) {
      return this.handleLeaderboard(ctx);
    }
    return this.handlePoints(ctx);
  }

  private async handlePoints(ctx: CapabilityCtx): Promise<Artifact> {
    const [balance, history] = await Promise.all([
      this.deps.loyaltyUseCase.getBalance(ctx.userId),
      this.deps.loyaltyUseCase.getHistory(ctx.userId, { limit: 5 }),
    ]);

    const fields: ResultField[] = [
      {
        label: "Balance",
        value: `${formatPoints(balance.pointsTotal)} pts`,
        emphasis: "primary",
      },
      {
        label: "Rank",
        value: balance.rank !== null ? `#${balance.rank}` : "—",
      },
    ];

    const historyHead = history.slice(0, MAX_HISTORY_FIELDS).map(buildHistoryEntry);
    fields.push(...historyHead);
    if (history.length === 0) {
      fields.push({ label: "Recent activity", value: "No activity yet", emphasis: "muted" });
    }

    const details: ResultField[] = history
      .slice(MAX_HISTORY_FIELDS)
      .map(buildHistoryEntry);

    const result: IntentResult = {
      status: "success",
      verb: "loyalty_query",
      headline: `Points — ${balance.seasonId}`,
      fields,
      details: details.length > 0 ? details : undefined,
      nextActions: [
        { label: "View leaderboard", kind: "command", payload: "/leaderboard" },
        { label: "Earn more", kind: "command", payload: "/yield" },
      ],
      complexity: "simple",
    };

    log.info(
      { step: "succeeded", userId: ctx.userId, seasonId: balance.seasonId, historyCount: history.length },
      "loyalty-points",
    );

    return { kind: "result_card", result };
  }

  private async handleLeaderboard(ctx: CapabilityCtx): Promise<Artifact> {
    const balance = await this.deps.loyaltyUseCase.getBalance(ctx.userId);
    const { entries, seasonId } = await this.deps.loyaltyUseCase.getLeaderboard(
      balance.seasonId,
      this.deps.leaderboardDefaultLimit,
    );

    const top = entries.slice(0, MAX_LEADERBOARD_FIELDS);
    const fields: ResultField[] = top.map((e) => ({
      label: `#${e.rank}  ${shortUserId(e.userId)}`,
      value: `${formatPoints(e.pointsTotal)} pts`,
      emphasis: e.userId === ctx.userId ? "primary" : "normal",
    }));
    if (top.length === 0) {
      fields.push({ label: "Status", value: "No entries yet", emphasis: "muted" });
    }

    const details: ResultField[] = entries
      .slice(MAX_LEADERBOARD_FIELDS, 10)
      .map((e) => ({
        label: `#${e.rank}  ${shortUserId(e.userId)}`,
        value: `${formatPoints(e.pointsTotal)} pts`,
      }));

    const result: IntentResult = {
      status: "success",
      verb: "loyalty_query",
      headline: `Leaderboard — ${seasonId}`,
      fields,
      details: details.length > 0 ? details : undefined,
      nextActions: [
        { label: "Your points", kind: "command", payload: "/points" },
        { label: "Earn more", kind: "command", payload: "/yield" },
      ],
      complexity: "simple",
    };

    log.info(
      { step: "succeeded", userId: ctx.userId, seasonId, entryCount: entries.length },
      "loyalty-leaderboard",
    );

    return { kind: "result_card", result };
  }
}
