export interface ISmartAccountService {
  deploy(userId: string): Promise<{ smartAccountAddress: string; txHash: string }>;
  getAddress(userId: string): Promise<string>;
  isDeployed(address: string): Promise<boolean>;
}
