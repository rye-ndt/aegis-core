import type { USER_INTENT_TYPE } from "../../../helpers/enums/userIntentType.enum";

export interface IIntentClassifier {
  classify(messages: string[]): Promise<USER_INTENT_TYPE>;
}
