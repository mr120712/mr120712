// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  shopFindFirst: vi.fn(),
  shopCreate: vi.fn(),
  shopUpdateMany: vi.fn(),
  productFindFirst: vi.fn(),
  productCreate: vi.fn(),
  productUpdateMany: vi.fn(),
  profileFindUnique: vi.fn(),
  profileUpsert: vi.fn(),
  userFindMany: vi.fn(),
  userFollowUpsert: vi.fn(),
  userFollowDeleteMany: vi.fn(),
  userFollowGroupBy: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: mocks.requireAuth,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/db', () => ({
  prisma: {
    shop: {
      findFirst: mocks.shopFindFirst,
      create: mocks.shopCreate,
      updateMany: mocks.shopUpdateMany,
    },
    product: {
      findFirst: mocks.productFindFirst,
      create: mocks.productCreate,
      updateMany: mocks.productUpdateMany,
    },
    userProfile: { findUnique: mocks.profileFindUnique, upsert: mocks.profileUpsert },
    user: { findMany: mocks.userFindMany },
    userFollow: {
      upsert: mocks.userFollowUpsert,
      deleteMany: mocks.userFollowDeleteMany,
      groupBy: mocks.userFollowGroupBy,
    },
  },
}));

import { DELETE as unfollow } from '@/app/api/community/follows/[profileId]/route';
import { POST as follow } from '@/app/api/community/follows/route';
import { PATCH as updateCommunityProfile } from '@/app/api/community/me/route';
import { PATCH as updateProduct } from '@/app/api/products/[productId]/route';
import { POST as addProduct } from '@/app/api/shops/[shopId]/products/route';
import { PATCH as updateShop } from '@/app/api/shops/[shopId]/route';
import { POST as createShop } from '@/app/api/shops/route';

const user = { id: 'user-1', name: 'Artista', role: 'user' };
const deniedResponse = () =>
  Response.json(
    { error: 'rate_limited', message: 'Riprova tra 10 secondi.', retryAfterSeconds: 10 },
    { status: 429, headers: { 'Retry-After': '10' } },
  );

function request(path: string, body: unknown) {
  return new Request(`https://solco.test${path}`, {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const shopParams = { params: Promise.resolve({ shopId: 'shop-1' }) };
const productParams = { params: Promise.resolve({ productId: 'product-1' }) };
const profileParams = { params: Promise.resolve({ profileId: 'profile-target' }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ user });
  mocks.requireAuth.mockResolvedValue(user);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockImplementation(async () => deniedResponse());
  mocks.shopFindFirst.mockResolvedValue({ id: 'shop-1', name: 'Negozio', createdAt: new Date() });
  mocks.shopCreate.mockResolvedValue({ id: 'shop-new', name: 'Nuovo', createdAt: new Date() });
  mocks.shopUpdateMany.mockResolvedValue({ count: 1 });
  mocks.productFindFirst.mockResolvedValue({ id: 'product-1' });
  mocks.productCreate.mockResolvedValue({
    id: 'product-new',
    shopId: 'shop-1',
    name: 'Album',
    url: 'https://shop.example/album',
    expectedPriceCents: 2500,
    expectedAvailability: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mocks.productUpdateMany.mockResolvedValue({ count: 1 });
  mocks.profileFindUnique.mockResolvedValue({
    id: 'profile-target',
    userId: 'user-2',
    profileVisibility: 'public',
  });
  mocks.profileUpsert.mockResolvedValue({
    id: 'profile-own',
    userId: user.id,
    profileRole: 'fan',
    profileVisibility: 'private',
    followersVisibility: 'private',
    followingVisibility: 'private',
  });
  mocks.userFindMany.mockResolvedValue([{ id: 'user-2', name: 'Secondo account' }]);
  mocks.userFollowUpsert.mockResolvedValue({ id: 'follow-1' });
  mocks.userFollowDeleteMany.mockResolvedValue({ count: 1 });
  mocks.userFollowGroupBy.mockResolvedValue([]);
});

describe('azioni di scrittura a budget per account', () => {
  it('limita creazione e modifica di negozi e prodotti prima della scrittura', async () => {
    const createShopResponse = await createShop(request('/api/shops', { name: 'Nuovo negozio' }));
    expect(createShopResponse.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('shops.create', 'user:user-1');
    expect(mocks.shopCreate).not.toHaveBeenCalled();

    mocks.enforceRateLimit.mockResolvedValue(null);
    const updateShopResponse = await updateShop(
      request('/api/shops/shop-1', { name: 'Nome aggiornato' }),
      shopParams,
    );
    expect(updateShopResponse.status).toBe(200);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('shops.update', 'user:user-1');
    expect(mocks.shopUpdateMany).toHaveBeenCalledOnce();

    mocks.enforceRateLimit.mockResolvedValueOnce(deniedResponse());
    const addProductResponse = await addProduct(
      request('/api/shops/shop-1/products', {
        name: 'Album',
        url: 'https://shop.example/album',
        expectedPriceCents: 2500,
        expectedAvailability: true,
        currency: 'EUR',
      }),
      shopParams,
    );
    expect(addProductResponse.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('products.create', 'user:user-1');
    expect(mocks.productCreate).not.toHaveBeenCalled();

    mocks.enforceRateLimit.mockResolvedValueOnce(deniedResponse());
    const updateProductResponse = await updateProduct(
      request('/api/products/product-1', { name: 'Titolo aggiornato' }),
      productParams,
    );
    expect(updateProductResponse.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('products.update', 'user:user-1');
    expect(mocks.productUpdateMany).not.toHaveBeenCalled();
  });

  it('limita follow, unfollow e modifica community senza cambiare le letture', async () => {
    const followResponse = await follow(
      request('/api/community/follows', { profileId: 'profile-target' }),
    );
    expect(followResponse.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('community.follow', 'user:user-1');
    expect(mocks.userFollowUpsert).not.toHaveBeenCalled();

    mocks.enforceRateLimit.mockResolvedValueOnce(deniedResponse());
    const unfollowResponse = await unfollow(
      new Request('https://solco.test/api/community/follows/profile-target', {
        method: 'DELETE',
        headers: { origin: 'https://solco.test' },
      }),
      profileParams,
    );
    expect(unfollowResponse.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('community.unfollow', 'user:user-1');
    expect(mocks.userFollowDeleteMany).not.toHaveBeenCalled();

    mocks.enforceRateLimit.mockResolvedValueOnce(deniedResponse());
    const profileResponse = await updateCommunityProfile(
      request('/api/community/me', {
        profileRole: 'artist',
        profileVisibility: 'public',
        followersVisibility: 'private',
        followingVisibility: 'private',
      }),
    );
    expect(profileResponse.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith(
      'community.profile.update',
      'user:user-1',
    );
    expect(mocks.profileUpsert).not.toHaveBeenCalled();
  });

  it('mantiene SameOrigin e autorizzazione prima del consumo del limite', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const csrfDenied = await createShop(request('/api/shops', { name: 'Nuovo negozio' }));
    expect(csrfDenied.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValue(true);
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const unauthenticated = await follow(
      request('/api/community/follows', { profileId: 'profile-target' }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });
});
