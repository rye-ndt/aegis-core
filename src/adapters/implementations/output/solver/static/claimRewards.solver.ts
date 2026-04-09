import { encodeFunctionData } from "viem";
import type { ISolver } from "../../../../../use-cases/interface/output/solver/solver.interface";
import type { IntentPackage } from "../../../../../use-cases/interface/output/intentParser.interface";

const REWARD_CONTROLLER_ABI = [
  {
    name: "claimRewards",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
  },
] as const;

export class ClaimRewardsSolver implements ISolver {
  readonly name = "claim_rewards_solver";

  constructor(private readonly rewardControllerAddress: string) {}

  async buildCalldata(
    _intent: IntentPackage,
    userAddress: string,
  ): Promise<{ to: string; data: string; value: string }> {
    const data = encodeFunctionData({
      abi: REWARD_CONTROLLER_ABI,
      functionName: "claimRewards",
      args: [userAddress as `0x${string}`],
    });
    return { to: this.rewardControllerAddress, data, value: "0" };
  }
}
