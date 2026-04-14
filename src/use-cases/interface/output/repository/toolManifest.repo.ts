export interface IToolManifestRecord {
  id:               string;
  toolId:           string;
  category:         string;
  name:             string;
  description:      string;
  protocolName:     string;
  tags:             string;   // raw JSON string of string[]
  priority:         number;
  isDefault:        boolean;
  inputSchema:      string;   // raw JSON string
  steps:            string;   // raw JSON string
  preflightPreview: string | null;
  revenueWallet:    string | null;
  isVerified:       boolean;
  isActive:         boolean;
  chainIds:         string;   // raw JSON string of number[]
  createdAtEpoch:   number;
  updatedAtEpoch:   number;
  requiredFields?:  string | null;   // JSON string — dual-schema human-readable fields
  finalSchema?:     string | null;   // JSON string — dual-schema machine-readable fields
}

export interface IToolManifestDB {
  create(manifest: IToolManifestRecord): Promise<void>;
  findByToolId(toolId: string): Promise<IToolManifestRecord | undefined>;
  findById(id: string): Promise<IToolManifestRecord | undefined>;
  listActive(chainId?: number): Promise<IToolManifestRecord[]>;
  deactivate(toolId: string): Promise<void>;

  /** Batch fetch by toolId. Only returns isActive=true records. */
  findByToolIds(toolIds: string[]): Promise<IToolManifestRecord[]>;

  /**
   * Keyword search across name, description, protocolName, and tags (ILIKE).
   * Results ordered by priority DESC, isDefault DESC.
   * Only returns isActive=true records.
   */
  search(
    query: string,
    options: { limit: number; category?: string; chainId?: number },
  ): Promise<IToolManifestRecord[]>;
}
