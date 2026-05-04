import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import type { LedgerEntry } from "../../../../use-cases/interface/output/repository/loyalty.repo";

export interface LoyaltyCapabilityDeps {
  loyaltyUseCase: ILoyaltyUseCase;
  leaderboardDefaultLimit: number;
}

const ACTION_LABELS: Record<string, string> = {
  swap_same_chain: "swap (same-chain)",
  swap_cross_chain: "swap (cross-chain)",
  send_erc20: "send",
  send_native: "send (native)",
  yield_deposit: "yield deposit",
  yield_hold_day: "yield hold",
  referral: "referral",
  manual_adjust: "adjustment",
};

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

function buildPointsMessage(
  balance: { seasonId: string; pointsTotal: bigint; rank: number | null },
  history: LedgerEntry[],
): string {
  const lines = [
    `🪙 *Points — ${balance.seasonId}*`,
    `Balance: *${formatPoints(balance.pointsTotal)}*`,
    balance.rank !== null ? `Rank: *#${balance.rank}*` : "Rank: —",
    "",
    "*Recent activity:*",
  ];

  if (history.length === 0) {
    lines.push("_No activity yet._");
  } else {
    for (const entry of history.slice(0, 5)) {
      const label = formatActionLabel(entry.actionType);
      const sign = entry.pointsRaw >= 0n ? "+" : "";
      const points = `${sign}${formatPoints(entry.pointsRaw)}`;
      const when = formatRelativeTime(entry.createdAtEpoch);
      lines.push(`• ${label} ${points} — ${when}`);
    }
  }

  lines.push("", "_Tip: yield deposits earn the most points._");
  return lines.join("\n");
}

function buildLeaderboardMessage(
  entries: { userId: string; pointsTotal: bigint; rank: number }[],
  seasonId: string,
): string {
  const lines = [`🏆 *Leaderboard — ${seasonId}*`, ""];

  if (entries.length === 0) {
    lines.push("_No entries yet._");
    return lines.join("\n");
  }

  for (const entry of entries) {
    const id = `${entry.userId.slice(0, 6)}…${entry.userId.slice(-4)}`;
    lines.push(`*#${entry.rank}*  ${id} — ${formatPoints(entry.pointsTotal)} pts`);
  }

  return lines.join("\n");
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
    const command = ctx.input.kind === "text"
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

    return {
      kind: "chat",
      parseMode: "Markdown",
      text: buildPointsMessage(balance, history),
    };
  }

  private async handleLeaderboard(ctx: CapabilityCtx): Promise<Artifact> {
    const balance = await this.deps.loyaltyUseCase.getBalance(ctx.userId);
    const { entries, seasonId } = await this.deps.loyaltyUseCase.getLeaderboard(
      balance.seasonId,
      this.deps.leaderboardDefaultLimit,
    );

    return {
      kind: "chat",
      parseMode: "Markdown",
      text: buildLeaderboardMessage(entries.slice(0, 10), seasonId),
    };
  }
}
