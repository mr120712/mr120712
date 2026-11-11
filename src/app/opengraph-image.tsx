// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// Open Graph / Twitter image — name, colors and optional background photo come
// from `brandVisual.og` in src/lib/brand.ts.
import { ImageResponse } from 'next/og';
import { brandVisual, siteName } from '@/lib/brand';
import { hexToRgba, loadOgBackground } from '@/lib/og-image';

export const alt = siteName;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  const { background, foreground, tagline } = brandVisual.og;
  // Read loosely: brand.ts is user-owned, so older apps have no `image` field.
  const og: Readonly<Record<string, unknown>> = brandVisual.og;
  const photo = await loadOgBackground(og.image);

  if (!photo) {
    return new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background,
          color: foreground,
          padding: '0 80px',
          textAlign: 'center',
        }}
      >
        <div style={{ display: 'flex', fontSize: 96, fontWeight: 700, letterSpacing: '-0.02em' }}>
          {siteName}
        </div>
        {tagline ? (
          <div style={{ display: 'flex', marginTop: 24, fontSize: 40, opacity: 0.7 }}>
            {tagline}
          </div>
        ) : null}
      </div>,
      size,
    );
  }

  // Photo card: full-bleed image, a brand-colored scrim rising from the bottom,
  // and the name + tagline set bottom-left over the scrim.
  return new ImageResponse(
    <div
      style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', background }}
    >
      {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img>. */}
      <img
        src={photo}
        alt=""
        width={size.width}
        height={size.height}
        style={{ position: 'absolute', top: 0, left: 0, objectFit: 'cover' }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          backgroundImage: `linear-gradient(to top, ${hexToRgba(background, 0.92)} 0%, ${hexToRgba(background, 0.6)} 40%, ${hexToRgba(background, 0)} 75%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '0 72px 64px',
          color: foreground,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: siteName.length > 24 ? 68 : 88,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
          }}
        >
          {siteName}
        </div>
        {tagline ? (
          <div style={{ display: 'flex', marginTop: 18, fontSize: 36, opacity: 0.85 }}>
            {tagline}
          </div>
        ) : null}
      </div>
    </div>,
    size,
  );
}
