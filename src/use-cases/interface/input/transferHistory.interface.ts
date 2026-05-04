import type {
  TransferDirection,
  TransferHistoryPage,
} from "../output/blockchain/transferHistoryProvider.interface";

export type GetHistoryInput = {
  userId: string;
  fromEpoch?: number;
  toEpoch?: number;
  direction?: TransferDirection;
  limit?: number;
  cursor?: string;
};

export interface ITransferHistoryUseCase {
  getHistory(input: GetHistoryInput): Promise<TransferHistoryPage>;
}
