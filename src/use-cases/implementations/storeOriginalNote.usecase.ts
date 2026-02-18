import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import type { ISqlDB } from "../interface/output/sqlDB.interface";

type Input = {
  userId: string;
  rawData: string;
};

type Output = {
  id: string;
};

export async function storeOriginalNote(
  sqlDB: ISqlDB,
  input: Input,
): Promise<Output> {
  const now = newCurrentUTCEpoch();
  const id = newUuid();

  await sqlDB.originalNotes.create({
    id,
    userId: input.userId,
    rawData: input.rawData,
    createdAtTimestamp: now,
    updatedAtTimestamp: now,
  });

  return { id };
}
