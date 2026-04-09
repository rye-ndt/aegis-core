import type { ISimulator } from "../../../../use-cases/interface/output/simulator.interface";
import type { IUserOperation } from "../../../../use-cases/interface/output/blockchain/userOperation.interface";
import type { IntentPackage, SimulationReport } from "../../../../use-cases/interface/output/intentParser.interface";
import { INTENT_ACTION } from "../../../../helpers/enums/intentAction.enum";
import type { ViemClientAdapter } from "../blockchain/viemClient";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export class RpcSimulator implements ISimulator {
  constructor(private readonly viemClient: ViemClientAdapter) {}

  async simulate(params: {
    userOp: IUserOperation;
    intent: IntentPackage;
    chainId: number;
  }): Promise<SimulationReport> {
    const { userOp, intent } = params;
    const warnings: string[] = [];

    try {
      await this.viemClient.publicClient.call({
        to: userOp.sender as `0x${string}`,
        data: userOp.callData as `0x${string}`,
        value: BigInt(userOp.callData.startsWith("0x") ? 0 : 0),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        tokenInDelta: "0",
        tokenOutDelta: "0",
        gasEstimate: "0",
        warnings: [`Simulation reverted: ${message}`],
      };
    }

    let gasEstimate = "200000";
    try {
      const gas = await this.viemClient.publicClient.estimateGas({
        to: userOp.sender as `0x${string}`,
        data: userOp.callData as `0x${string}`,
      });
      gasEstimate = gas.toString();
    } catch {
      warnings.push("Gas estimation failed; using default");
    }

    // TODO: token delta tracking — re-enable after token resolution step is added
    // const tokenInDelta = intent.tokenIn ? `-${intent.tokenIn.amountRaw}` : "0";
    const tokenInDelta = "0";
    const tokenOutDelta = "0";

    // TODO: re-enable after token resolution step is added
    // if (intent.action === INTENT_ACTION.SWAP && !intent.tokenIn) { ... }

    return {
      passed: true,
      tokenInDelta,
      tokenOutDelta,
      gasEstimate,
      warnings,
    };
  }
}
