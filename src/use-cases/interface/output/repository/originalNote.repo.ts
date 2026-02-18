export type OriginalNote = {
  id: string;
  userId: string;
  rawData: string;
  createdAtTimestamp: number;
  updatedAtTimestamp: number;
};

export interface IOriginalNoteDB {
  create(note: OriginalNote): Promise<void>;
  findById(id: string): Promise<OriginalNote | null>;
  findByIds(ids: string[]): Promise<OriginalNote[]>;
  findLatestByUserId(userId: string, limit: number): Promise<OriginalNote[]>;
}
