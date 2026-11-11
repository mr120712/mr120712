// @polsia:user-owned
import type { Metadata } from 'next';
import { ProductDetail } from '@/components/custom/product-detail';

export const metadata: Metadata = {
  title: 'Scheda prodotto',
  description: 'Valori attesi, esito dell’ultimo controllo e correzioni da rivedere.',
};

export default async function ProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <ProductDetail productId={productId} />;
}
