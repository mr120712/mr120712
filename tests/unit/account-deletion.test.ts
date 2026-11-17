// @vitest-environment node
// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  type AccountDeletionTransaction,
  deleteAccountData,
} from '@/lib/business/account-deletion';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDeletionRequestSchema,
} from '@/lib/contracts/account-deletion';

describe('cancellazione dell’account Solco', () => {
  it('richiede una conferma esplicita e non accetta campi aggiuntivi', () => {
    expect(
      AccountDeletionRequestSchema.safeParse({ confirmation: ACCOUNT_DELETION_CONFIRMATION })
        .success,
    ).toBe(true);
    expect(AccountDeletionRequestSchema.safeParse({ confirmation: 'ELIMINA' }).success).toBe(false);
    expect(
      AccountDeletionRequestSchema.safeParse({
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        userId: 'another-user',
      }).success,
    ).toBe(false);
  });

  it('elimina solo i record dell’utente, poi l’account nella stessa transazione', async () => {
    const operations: string[] = [];
    const ownedModel = (name: string) => ({
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        operations.push(`${name}:${where.userId}`);
        return { count: 1 };
      },
    });
    const userFollow = {
      deleteMany: async ({
        where,
      }: {
        where: { OR: Array<{ followerId: string } | { followedId: string }> };
      }) => {
        operations.push(`userFollow:${JSON.stringify(where.OR)}`);
        return { count: 1 };
      },
    };
    const transaction: AccountDeletionTransaction = {
      userProfile: ownedModel('userProfile'),
      userFollow,
      listeningEntry: ownedModel('listeningEntry'),
      userMusicCollection: ownedModel('userMusicCollection'),
      musicFreePreviewUsage: ownedModel('musicFreePreviewUsage'),
      solcoProPreference: ownedModel('solcoProPreference'),
      solcoProEntitlement: ownedModel('solcoProEntitlement'),
      solcoProStripeEntitlement: ownedModel('solcoProStripeEntitlement'),
      solcoProCheckoutOrder: ownedModel('solcoProCheckoutOrder'),
      productCheck: ownedModel('productCheck'),
      shop: ownedModel('shop'),
      userMusicFolder: ownedModel('userMusicFolder'),
      userSavedStation: ownedModel('userSavedStation'),
      userPodcastFollow: ownedModel('userPodcastFollow'),
      userPlaybackHistory: ownedModel('userPlaybackHistory'),
      userHiddenItem: ownedModel('userHiddenItem'),
      premiumGrant: ownedModel('premiumGrant'),
      referralCode: ownedModel('referralCode'),
      listeningDay: ownedModel('listeningDay'),
      userRewardProfile: ownedModel('userRewardProfile'),
      musicPlay: ownedModel('musicPlay'),
      aiMusicSearchCache: ownedModel('aiMusicSearchCache'),
      referral: {
        deleteMany: async ({ where }) => {
          operations.push(`referral:${JSON.stringify(where.OR)}`);
          return { count: 1 };
        },
      },
      user: {
        delete: async ({ where }) => {
          operations.push(`user:${where.id}`);
          return { id: where.id };
        },
      },
      verification: {
        deleteMany: async ({ where }) => {
          operations.push(`verification:${JSON.stringify(where.OR)}`);
          return { count: 1 };
        },
      },
    };

    await deleteAccountData(transaction, 'user-17', 'listener@example.test');

    expect(operations).toEqual([
      'userFollow:[{"followerId":"user-17"},{"followedId":"user-17"}]',
      'userProfile:user-17',
      'listeningEntry:user-17',
      'userMusicCollection:user-17',
      'musicFreePreviewUsage:user-17',
      'solcoProEntitlement:user-17',
      'solcoProStripeEntitlement:user-17',
      'solcoProCheckoutOrder:user-17',
      'solcoProPreference:user-17',
      'productCheck:user-17',
      'shop:user-17',
      'userMusicFolder:user-17',
      'userSavedStation:user-17',
      'userPodcastFollow:user-17',
      'userPlaybackHistory:user-17',
      'userHiddenItem:user-17',
      'premiumGrant:user-17',
      'referralCode:user-17',
      'listeningDay:user-17',
      'userRewardProfile:user-17',
      'musicPlay:user-17',
      'aiMusicSearchCache:user-17',
      'referral:[{"inviterId":"user-17"},{"inviteeId":"user-17"}]',
      'verification:[{"identifier":"listener@example.test"},{"identifier":{"endsWith":":listener@example.test"}}]',
      'user:user-17',
    ]);
  });

  it('cancella anche i consigli personali in cache e i «Non mi interessa»', async () => {
    const deleted: string[] = [];
    // Ogni modello registra cosa cancella; `user` è l'account stesso.
    const transaction = new Proxy(
      {},
      {
        get: (_target, model: string) =>
          model === 'user'
            ? { delete: async () => ({}) }
            : {
                findMany: async () => [],
                deleteMany: async ({ where }: { where: { userId?: string } }) => {
                  deleted.push(`${model}:${where.userId ?? ''}`);
                  return { count: 1 };
                },
              },
      },
    ) as AccountDeletionTransaction;

    await deleteAccountData(transaction, 'user-18', 'other@example.test');

    expect(deleted).toContain('recommendationCache:user-18');
    expect(deleted).toContain('recommendationHidden:user-18');
  });

  it('toglie bot Telegram, piano scelto, conversazioni, segnalazioni e brani pubblicati', async () => {
    const operations: string[] = [];
    const record = (model: string) => ({
      deleteMany: async ({ where }: { where: unknown }) => {
        operations.push(`${model}.deleteMany:${JSON.stringify(where)}`);
        return { count: 1 };
      },
    });
    const blobUrls = [
      'https://blob.example/public-uploads/a.mp3',
      'https://blob.example/public-uploads/b.mp3',
    ];
    const transaction = new Proxy(
      {},
      {
        get: (_target, model: string) => {
          if (model === 'user') {
            return {
              delete: async ({ where }: { where: { id: string } }) => {
                operations.push(`user.delete:${where.id}`);
                return {};
              },
            };
          }
          if (model === 'publicUpload') {
            return {
              ...record(model),
              findMany: async (args: unknown) => {
                operations.push(`publicUpload.findMany:${JSON.stringify(args)}`);
                return blobUrls.map((blobUrl) => ({ blobUrl }));
              },
            };
          }
          return record(model);
        },
      },
    ) as AccountDeletionTransaction;

    const result = await deleteAccountData(transaction, 'user-19', 'third@example.test');

    // I file su Blob tornano al chiamante: si tolgono dalla CDN solo dopo il commit.
    expect(result).toEqual({ publicUploadBlobUrls: blobUrls });
    expect(operations).toEqual(
      expect.arrayContaining([
        'telegramAccountLink.deleteMany:{"userId":"user-19"}',
        'botUse.deleteMany:{"userId":"user-19"}',
        'solcoPlanSelection.deleteMany:{"userId":"user-19"}',
        'conversation.deleteMany:{"OR":[{"participantAId":"user-19"},{"participantBId":"user-19"}]}',
        'publicUploadReport.deleteMany:{"reporterUserId":"user-19"}',
        'publicUpload.deleteMany:{"uploaderUserId":"user-19"}',
      ]),
    );
    expect(
      operations.indexOf(
        'publicUpload.findMany:{"where":{"uploaderUserId":"user-19"},"select":{"blobUrl":true}}',
      ),
    ).toBeLessThan(operations.indexOf('publicUpload.deleteMany:{"uploaderUserId":"user-19"}'));
    expect(operations.at(-1)).toBe('user.delete:user-19');
    // Restano i pagamenti (obblighi contabili) e il registro del vecchio database (solo id).
    expect(operations.some((operation) => /subscription|legacyUserImport/i.test(operation))).toBe(
      false,
    );
  });

  it('senza brani pubblicati non c’è nessun file da togliere', async () => {
    const transaction = new Proxy(
      {},
      {
        get: (_target, model: string) =>
          model === 'user'
            ? { delete: async () => ({}) }
            : { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      },
    ) as AccountDeletionTransaction;

    expect(await deleteAccountData(transaction, 'user-20', 'none@example.test')).toEqual({
      publicUploadBlobUrls: [],
    });
  });
});
