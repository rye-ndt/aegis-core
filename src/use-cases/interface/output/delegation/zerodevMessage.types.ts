import { z } from 'zod';
import { ZERODEV_MESSAGE_TYPE } from '../../../../helpers/enums/zerodevMessageType.enum';

// Field names mirror @zerodev/permissions/policies types so the FE can pass
// them through with no renaming:
//   target     → Permission.target          (the ERC20 contract address)
//   valueLimit → ConditionValue.value in args[1] of toCallPolicy (bigint after BigInt())
//   validUntil → TimestampPolicyParams.validUntil
export const Erc20SpendMessageSchema = z.object({
  type: z.literal(ZERODEV_MESSAGE_TYPE.ERC20_SPEND),
  sessionKeyAddress: z.string(), // 0x… — keypair address from onboarding
  target: z.string(),            // 0x… — ERC20 contract; maps to Permission.target
  valueLimit: z.string(),        // BigInt decimal string; maps to ConditionValue.value (no float loss)
  validUntil: z.number(),        // unix epoch; maps to TimestampPolicyParams.validUntil
  chainId: z.number(),
});
export type Erc20SpendMessage = z.infer<typeof Erc20SpendMessageSchema>;

// Discriminated union — add new message types here
export const ZerodevMessageSchema = z.discriminatedUnion('type', [
  Erc20SpendMessageSchema,
]);
export type ZerodevMessage = z.infer<typeof ZerodevMessageSchema>;

/**
 * Extracts the expiry epoch from any ZerodevMessage variant.
 * Exhaustive switch ensures this is updated when new types are added.
 */
export function resolveExpiresAtEpoch(msg: ZerodevMessage): number {
  switch (msg.type) {
    case ZERODEV_MESSAGE_TYPE.ERC20_SPEND:
      return msg.validUntil;
  }
}
