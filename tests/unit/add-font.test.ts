// @vitest-environment node
// node not jsdom — jsdom rewrites import.meta.url to a non-file scheme.
import { describe, expect, it } from 'vitest';

interface Face {
  subset: string;
  style: string;
  weight: string;
  unicodeRange?: string;
  url: string;
}
interface AddFont {
  slugify(family: string): string;
  parseStyle(spec: string): { weight: string; italic: boolean };
  cssUrl(family: string, styles: { weight: string; italic: boolean }[]): string;
  parseFaces(css: string): Face[];
  fontFaceBlock(family: string, slug: string, faces: Face[]): string;
  upsertBlock(css: string, family: string, block: string): string;
}

// A runtime URL keeps the plain-JS script out of the TypeScript program.
const script = new URL('../../scripts/add-font.mjs', import.meta.url).href;
const addFont = (await import(/* @vite-ignore */ script)) as AddFont;

const response = `/* cyrillic */
@font-face {
  font-family: 'Cormorant Garamond';
  font-style: normal;
  font-weight: 600;
  src: url(https://fonts.gstatic.com/s/cg/cyrillic.woff2) format('woff2');
  unicode-range: U+0400-045F;
}
/* latin-ext */
@font-face {
  font-family: 'Cormorant Garamond';
  font-style: normal;
  font-weight: 600;
  src: url(https://fonts.gstatic.com/s/cg/latin-ext.woff2) format('woff2');
  unicode-range: U+0100-02BA;
}
/* latin */
@font-face {
  font-family: 'Cormorant Garamond';
  font-style: italic;
  font-weight: 300 700;
  src: url(https://fonts.gstatic.com/s/cg/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;

describe('font:add', () => {
  it('builds a CSS2 API URL with sorted, de-duplicated ital/wght tuples', () => {
    const styles = ['600', '400italic', '400', '600'].map(addFont.parseStyle);
    expect(addFont.cssUrl('Cormorant Garamond', styles)).toBe(
      'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap',
    );
    expect(addFont.parseStyle('300..800')).toEqual({ weight: '300..800', italic: false });
    expect(() => addFont.parseStyle('bold')).toThrow(/Unrecognized style/);
  });

  it('keeps only latin subsets and self-hosts them under the family slug', () => {
    const faces = addFont.parseFaces(response);
    expect(faces.map((f) => f.subset)).toEqual(['latin-ext', 'latin']);
    const block = addFont.fontFaceBlock(
      'Cormorant Garamond',
      addFont.slugify('Cormorant Garamond'),
      faces,
    );
    expect(block).toContain('font-family: "Cormorant Garamond";');
    expect(block).toContain(
      'src: url("/fonts/cormorant-garamond/cormorant-garamond-300-700-italic-latin.woff2") format("woff2");',
    );
    expect(block).not.toContain('gstatic');
  });

  it('replaces the family block on re-run and leaves other families alone', () => {
    const block = (body: string, family = 'Cormorant Garamond') =>
      `/* font:add ${family} — start */\n${body}\n/* font:add ${family} — end */`;
    let css = '@import "x.css";\n';
    css = addFont.upsertBlock(css, 'Cormorant Garamond', block('old'));
    css = addFont.upsertBlock(css, 'Inter Tight', block('inter', 'Inter Tight'));
    css = addFont.upsertBlock(css, 'Cormorant Garamond', block('new'));
    expect(css).toContain('new');
    expect(css).not.toContain('old');
    expect(css).toContain('inter');
    expect(css.startsWith('@import "x.css";')).toBe(true);
  });
});
