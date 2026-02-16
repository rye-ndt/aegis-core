import { PRIMARY_CATEGORY } from "../../../../helpers/enums/categories.enum";
import { MATERIAL_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface Material {
  id: string;
  userId: string;
  originalNoteId: string;
  category: PRIMARY_CATEGORY;
  tags: string[];
  rewrittenContent: string;
  originalContent: string;
  status: MATERIAL_STATUSES;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IMaterialDB {
  create(material: Material): Promise<void>;
  findByIds(ids: string[], status: MATERIAL_STATUSES[]): Promise<Material[]>;
  findByCategory(
    category: PRIMARY_CATEGORY,
    status: MATERIAL_STATUSES[],
  ): Promise<Material[]>;
  findByUserId(
    userId: string,
    status: MATERIAL_STATUSES[],
  ): Promise<Material[]>;
}

