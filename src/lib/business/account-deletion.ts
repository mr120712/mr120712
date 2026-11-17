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
  /** TikTok tokens (no relation to User, so deleted explicitly). Optional as above. */
  tikTokConnection?: UserOwnedRecords;
  /** Dates of YouTube data in the listening history (no relation to User). Optional as above. */
  youTubeHistoryFetch?: UserOwnedRecords;
  /** «Potrebbe piacerti»: candidati in cache e brani «Non mi interessa». Optional as above. */
  recommendationCache?: UserOwnedRecords;
  recommendationHidden?: UserOwnedRecords;
  /** UID leggibile dell'account (gestione account; nessuna relazione con User). Optional as above. */
  userUid?: UserOwnedRecords;
  /** Collegamento al bot Telegram (chat id e username; nessuna relazione con User). Optional as above. */
  telegramAccountLink?: UserOwnedRecords;
  /** Usi mensili del bot (nessuna relazione con User). Optional as above. */
  botUse?: UserOwnedRecords;
  /** Piano scelto prima del pagamento (nessuna relazione con User). Optional as above. */
  solcoPlanSelection?: UserOwnedRecords;
  /** Conversazioni private: i messaggi seguono per cascata. Optional as above. */
  conversation?: {
    deleteMany(args: {
      where: { OR: Array<{ participantAId: string } | { participantBId: string }> };
    }): Promise<unknown>;
  };
  /** Segnalazioni fatte dall'utente ai brani pubblicati. Optional as above. */
  publicUploadReport?: {
    deleteMany(args: { where: { reporterUserId: string } }): Promise<unknown>;
  };
  /** Brani pubblicati dall'utente: segnalazioni e ascolti seguono per cascata. Optional as above. */
  publicUpload?: {
    findMany(args: {
      where: { uploaderUserId: string };
      select: { blobUrl: true };
    }): Promise<Array<{ blobUrl: string }>>;
    deleteMany(args: { where: { uploaderUserId: string } }): Promise<unknown>;
  };
  referral: {
    deleteMany(args: {
      where: { OR: Array<{ inviterId: string } | { inviteeId: string }> };
    }): Promise<unknown>;
  };
  user: AuthUserRecord;
  verification: VerificationRecords;
};

export type AccountDeletionResult = {
  /**
   * File su Vercel Blob dei brani pubblicati dall'account. Le righe spariscono nella transazione;
   * i file si tolgono dalla CDN DOPO il commit (un rollback non deve lasciare righe senza file).
   */
  publicUploadBlobUrls: string[];
};

/**
 * Cancella tutti i dati dell'account dentro una transazione.
 *
 * Restano di proposito:
 * - abbonamenti e pagamenti (SolcoSubscription, PayPalSubscription, SolcoIapSubscription): sono
 *   registrazioni contabili da conservare per legge, e la cancellazione non chiude un abbonamento
 *   attivo presso Stripe, PayPal o Apple (lo dice anche l'informativa privacy);
 * - LegacyUserImport: solo id, nessun dato personale. È il registro che impedisce a un futuro
 *   trasferimento dal vecchio database di ricreare un account che l'utente ha cancellato;
 * - righe scritte dagli amministratori (fonti di riproduzione, prove dei diritti, clip TikTok):
 *   tengono traccia di chi ha fatto cosa nell'amministrazione.
 */
export async function deleteAccountData(
  transaction: AccountDeletionTransaction,
  userId: string,
  email: string,
): Promise<AccountDeletionResult> {
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
  await transaction.youTubeHistoryFetch?.deleteMany({ where: { userId } });
  await transaction.userHiddenItem.deleteMany({ where: { userId } });
  await transaction.premiumGrant.deleteMany({ where: { userId } });
  await transaction.referralCode.deleteMany({ where: { userId } });
  await transaction.listeningDay.deleteMany({ where: { userId } });
  await transaction.userRewardProfile.deleteMany({ where: { userId } });
  await transaction.musicPlay.deleteMany({ where: { userId } });
  await transaction.aiMusicSearchCache.deleteMany({ where: { userId } });
  // Consigli personali («Potrebbe piacerti»): nessuna relazione con User, cancellati qui.
  await transaction.recommendationCache?.deleteMany({ where: { userId } });
  await transaction.recommendationHidden?.deleteMany({ where: { userId } });
  // UID leggibile dell'account (gestione account): va via con l'account.
  await transaction.userUid?.deleteMany({ where: { userId } });
  // Spotify tokens: the Spotify Developer Policy requires deleting them with the account.
  await transaction.spotifyConnection?.deleteMany({ where: { userId } });
  // TikTok tokens: deleted with the account (no relation to User).
  await transaction.tikTokConnection?.deleteMany({ where: { userId } });
  // Bot Telegram: collegamento (chat id, username) e conteggio degli usi.
  await transaction.telegramAccountLink?.deleteMany({ where: { userId } });
  await transaction.botUse?.deleteMany({ where: { userId } });
  await transaction.solcoPlanSelection?.deleteMany({ where: { userId } });
  // Conversazioni private in cui l'utente è uno dei due: i messaggi vanno via per cascata.
  await transaction.conversation?.deleteMany({
    where: { OR: [{ participantAId: userId }, { participantBId: userId }] },
  });
  await transaction.publicUploadReport?.deleteMany({ where: { reporterUserId: userId } });
  const uploads =
    (await transaction.publicUpload?.findMany({
      where: { uploaderUserId: userId },
      select: { blobUrl: true },
    })) ?? [];
  await transaction.publicUpload?.deleteMany({ where: { uploaderUserId: userId } });
  await transaction.referral.deleteMany({
    where: { OR: [{ inviterId: userId }, { inviteeId: userId }] },
  });
  await transaction.verification.deleteMany({
    where: { OR: [{ identifier: email }, { identifier: { endsWith: `:${email}` } }] },
  });
  await transaction.user.delete({ where: { id: userId } });
  return { publicUploadBlobUrls: uploads.map((upload) => upload.blobUrl) };
}
