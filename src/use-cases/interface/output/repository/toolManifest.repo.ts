import type { SOLVER_TYPE } from "../../../../helpers/enums/solverType.enum";

export interface IToolManifest {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  solverType: SOLVER_TYPE;
  endpointUrl?: string | null;
  inputSchema: string;
  outputSchema: string;
  contributorAddress?: string | null;
  revShareBps: number;
  isActive: boolean;
  chainIds: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IToolManifestDB {
  upsert(manifest: IToolManifest): Promise<void>;
  findByName(name: string): Promise<IToolManifest | undefined>;
  listActive(chainId?: number): Promise<IToolManifest[]>;
}
