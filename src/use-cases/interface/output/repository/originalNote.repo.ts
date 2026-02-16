export type OriginalNote = {
  id: string;
  userId: string;
  rawData: string;
  createdAtTimestamp: number;
  updatedAtTimestamp: number;
};

export type OriginalNoteCreate = OriginalNote;

export interface IOriginalNoteDB {
  create(note: OriginalNoteCreate): Promise<void>;
  findById(id: string): Promise<OriginalNote | null>;
  findByIds(ids: string[]): Promise<OriginalNote[]>;
  findLatestByUserId(userId: string, limit: number): Promise<OriginalNote[]>;
}

