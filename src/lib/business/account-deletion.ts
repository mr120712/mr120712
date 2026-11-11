// @polsia:user-owned
type UserOwnedRecords = {
  deleteMany(args: { where: { userId: string } }): Promise<unknown>;
};

type AuthUserRecord = {
  delete(args: { where: { id: string } }): Promise<unknown>;
};

type VerificationRecords = {
  deleteMany(args: {
    where: {
      OR: Array<{ identifier: string } | { identifier: { endsWith: string } }>;
    };
  }): Promise<unknown>;
};

export type AccountDeletionTransaction = {
  userProfile: UserOwnedRecords;
  userFollow: {
    deleteMany(args: {
      where: { OR: Array<{ followerId: string } | { followedId: string }> };
    }): Promise<unknown>;
  };
  listeningEntry: UserOwnedRecords;
  userMusicCollection: UserOwnedRecords;
  musicFreePreviewUsage: UserOwnedRecords;
  solcoProPreference: UserOwnedRecords;
  solcoProEntitlement: UserOwnedRecords;
  solcoProStripeEntitlement: UserOwnedRecords;
  solcoProCheckoutOrder: UserOwnedRecords;
  productCheck: UserOwnedRecords;
  shop: UserOwnedRecords;
  user: AuthUserRecord;
  verification: VerificationRecords;
};

export async function deleteAccountData(
  transaction: AccountDeletionTransaction,
  userId: string,
  email: string,
): Promise<void> {
  await transaction.userFollow.deleteMany({
    where: { OR: [{ followerId: userId }, { followedId: userId }] },
  });
  await transaction.userProfile.deleteMany({ where: { userId } });
  await transaction.listeningEntry.deleteMany({ where: { userId } });
  await transaction.userMusicCollection.deleteMany({ where: { userId } });
  await transaction.musicFreePreviewUsage.deleteMany({ where: { userId } });
  await transaction.solcoProEntitlement.deleteMany({ where: { userId } });
  await transaction.solcoProStripeEntitlement.deleteMany({ where: { userId } });
  await transaction.solcoProCheckoutOrder.deleteMany({ where: { userId } });
  await transaction.solcoProPreference.deleteMany({ where: { userId } });
  await transaction.productCheck.deleteMany({ where: { userId } });
  await transaction.shop.deleteMany({ where: { userId } });
  await transaction.verification.deleteMany({
    where: { OR: [{ identifier: email }, { identifier: { endsWith: `:${email}` } }] },
  });
  await transaction.user.delete({ where: { id: userId } });
}
