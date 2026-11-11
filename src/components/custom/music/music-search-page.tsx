// @polsia:user-owned — pagina Cerca: musica Audius/YouTube più radio e podcast.
'use client';

import { MusicSearch } from '@/components/custom/music/music-search';
import { SearchExtras } from '@/components/custom/music/search-extras';

export function MusicSearchPage({ initialQuery }: { initialQuery: string }) {
  return (
    <MusicSearch
      initialQuery={initialQuery}
      extras={(query) => <SearchExtras key={query} query={query} />}
    />
  );
}
