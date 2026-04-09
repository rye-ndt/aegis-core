import type { IntentPackage } from "../../../../use-cases/interface/output/intentParser.interface";
import { INTENT_ACTION } from "../../../../helpers/enums/intentAction.enum";
import type { ViemClientAdapter } from "../blockchain/viemClient";

const ERC20_ABI = [
  {
    name: "Transfer",
    type: "event",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface IResultParser {
  parse(params: {
    txHash: string;
    intent: IntentPackage;
    chainId: number;
  }): Promise<string>;
}

export class TxResultParser implements IResultParser {
  constructor(private readonly viemClient: ViemClientAdapter) {}

  async parse(params: {
    txHash: string;
    intent: IntentPackage;
    chainId: number;
  }): Promise<string> {
    const { txHash, intent } = params;
    const shortTx = `${txHash.slice(0, 10)}...${txHash.slice(-6)}`;

    try {
      const receipt = await this.viemClient.publicClient.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });

      if (!receipt.status || receipt.status === "reverted") {
        return `Transaction failed on-chain. Tx: ${shortTx}`;
      }

      // TODO: restore token details after token resolution step is added
      // if (intent.action === INTENT_ACTION.SWAP && intent.tokenIn && intent.tokenOut) {
      //   return `Success! Swapped ${intent.tokenIn.amountHuman} ${intent.tokenIn.symbol} → ${intent.tokenOut.symbol}. Tx: ${shortTx}`;
      // }
      if (intent.action === INTENT_ACTION.SWAP) {
        return `Success! Swap completed. Tx: ${shortTx}`;
      }

      if (intent.action === INTENT_ACTION.CLAIM_REWARDS) {
        return `Success! Rewards claimed. Tx: ${shortTx}`;
      }

      // TODO: restore token details after token resolution step is added
      // if (intent.action === INTENT_ACTION.TRANSFER && intent.tokenIn) {
      //   return `Success! Transferred ${intent.tokenIn.amountHuman} ${intent.tokenIn.symbol}. Tx: ${shortTx}`;
      // }
      if (intent.action === INTENT_ACTION.TRANSFER) {
        return `Success! Transfer completed. Tx: ${shortTx}`;
      }

      return `Success! Transaction confirmed. Tx: ${shortTx}`;
    } catch {
      return `Transaction submitted. Tx: ${shortTx}`;
    }
  }
}
