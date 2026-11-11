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
  userMusicFolder: UserOwnedRecords;
  userSavedStation: UserOwnedRecords;
  userPodcastFollow: UserOwnedRecords;
  userPlaybackHistory: UserOwnedRecords;
  userHiddenItem: UserOwnedRecords;
  premiumGrant: UserOwnedRecords;
  referralCode: UserOwnedRecords;
  listeningDay: UserOwnedRecords;
  userRewardProfile: UserOwnedRecords;
  musicPlay: UserOwnedRecords;
  aiMusicSearchCache: UserOwnedRecords;
  /**
   * Spotify tokens (no relation to User, so deleted explicitly). Optional only so callers built
   * before the Spotify import keep compiling; the Prisma transaction client always provides it.
   */
  spotifyConnection?: UserOwnedRecords;
  referral: {
    deleteMany(args: {
      where: { OR: Array<{ inviterId: string } | { inviteeId: string }> };
    }): Promise<unknown>;
  };
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
  // Library and rewards data added with the app restructure.
  await transaction.userMusicFolder.deleteMany({ where: { userId } });
  await transaction.userSavedStation.deleteMany({ where: { userId } });
  await transaction.userPodcastFollow.deleteMany({ where: { userId } });
  await transaction.userPlaybackHistory.deleteMany({ where: { userId } });
  await transaction.userHiddenItem.deleteMany({ where: { userId } });
  await transaction.premiumGrant.deleteMany({ where: { userId } });
  await transaction.referralCode.deleteMany({ where: { userId } });
  await transaction.listeningDay.deleteMany({ where: { userId } });
  await transaction.userRewardProfile.deleteMany({ where: { userId } });
  await transaction.musicPlay.deleteMany({ where: { userId } });
  await transaction.aiMusicSearchCache.deleteMany({ where: { userId } });
  // Spotify tokens: the Spotify Developer Policy requires deleting them with the account.
  await transaction.spotifyConnection?.deleteMany({ where: { userId } });
  await transaction.referral.deleteMany({
    where: { OR: [{ inviterId: userId }, { inviteeId: userId }] },
  });
  await transaction.verification.deleteMany({
    where: { OR: [{ identifier: email }, { identifier: { endsWith: `:${email}` } }] },
  });
  await transaction.user.delete({ where: { id: userId } });
}
