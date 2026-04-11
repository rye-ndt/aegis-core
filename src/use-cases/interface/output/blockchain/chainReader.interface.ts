export interface IChainReader {
  getNativeBalance(address: `0x${string}`): Promise<bigint>;
  getErc20Balance(tokenAddress: `0x${string}`, account: `0x${string}`): Promise<bigint>;
}
