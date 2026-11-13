// @polsia:user-owned — the agent OWNS this file (edit freely).
//
// App-wide client Context providers go here. AppProviders is rendered by the root
// layout as an ancestor of the nav, page, footer and global mounts, so a Context
// added here reaches every client component (nav, hero, CTAs, modals, forms).
// Put a provider HERE — never scoped to a single leaf like a modal, or consumers
// elsewhere throw "useX must be used within YProvider" during server render.
//
// Example:
//   'use client';
//   import { AuthProvider } from '@/lib/auth-context';
//   export function AppProviders({ children }: { children: React.ReactNode }) {
//     return <AuthProvider>{children}</AuthProvider>;
//   }
//
// Default is a transparent pass-through — safe to leave as-is.

'use client';

import { LibraryProvider } from '@/components/custom/music/library-context';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';
import { RequireLogin } from '@/components/custom/require-login';

export function AppProviders({ children }: { children: React.ReactNode }) {
  // Muro di login come wrapper più esterno: senza sessione (e fuori dalle rotte pubbliche) non si
  // monta nulla sotto — né nav, né player, né pagina — e si reindirizza a /login.
  return (
    <RequireLogin>
      <LibraryProvider>
        <MusicPlayerProvider>{children}</MusicPlayerProvider>
      </LibraryProvider>
    </RequireLogin>
  );
}
