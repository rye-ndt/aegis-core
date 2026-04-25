import { z } from "zod";

export const SeasonConfigSchema = z.object({
  globalMultiplier: z.number(),
  perActionCap: z.number(),
  dailyUserCap: z.number().nullable(),
  actionBase: z.record(z.string(), z.number()),
  actionMultiplier: z.record(z.string(), z.number()),
  actionMinUsd: z.record(z.string(), z.number()),
  volume: z.object({
    formula: z.enum(["sqrt", "log", "linear"]),
    divisor: z.number().positive(),
  }),
});

export type SeasonConfig = z.infer<typeof SeasonConfigSchema>;

export type PointsInput = {
  actionType: string;
  usdValue?: number;
  userMultiplier?: number;
};

export type ComputeBreakdown = {
  base: number;
  volFactor: number;
  actionMult: number;
  globalMult: number;
  userMult: number;
  raw: number;
  capped: number;
};

export function computePointsV1(
  input: PointsInput,
  season: SeasonConfig,
  actionDefaults: { defaultBase: bigint },
): { points: bigint; breakdown: ComputeBreakdown } {
  const { actionType, usdValue, userMultiplier = 1 } = input;

  const base = season.actionBase[actionType] ?? Number(actionDefaults.defaultBase);
  const minUsd = season.actionMinUsd[actionType] ?? 0;

  const actionMult = season.actionMultiplier[actionType] ?? 1;

  if (usdValue !== undefined && usdValue < minUsd) {
    return {
      points: 0n,
      breakdown: {
        base,
        volFactor: 0,
        actionMult,
        globalMult: season.globalMultiplier,
        userMult: userMultiplier,
        raw: 0,
        capped: 0,
      },
    };
  }

  let volFactor = 1;
  if (usdValue !== undefined && usdValue > 0) {
    const ratio = usdValue / season.volume.divisor;
    if (season.volume.formula === "sqrt") {
      volFactor = Math.sqrt(ratio);
    } else if (season.volume.formula === "log") {
      volFactor = Math.log(ratio + 1);
    } else {
      volFactor = ratio;
    }
  }

  const raw = base * volFactor * actionMult * season.globalMultiplier * userMultiplier;
  const capped = Math.min(raw, season.perActionCap);
  const points = BigInt(Math.max(Math.round(capped), 1));

  return {
    points,
    breakdown: { base, volFactor, actionMult, globalMult: season.globalMultiplier, userMult: userMultiplier, raw, capped },
  };
}
