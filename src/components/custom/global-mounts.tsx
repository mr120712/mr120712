// @polsia:user-owned — the agent OWNS this file (edit freely).
// Writable home for root/global UI (Cmd+K palette, global keyboard listeners,
// app-wide overlays/dialogs), mounted once at the app root by layout.tsx.
// Put root mounts here, NOT in framework-owned layout.tsx. Returns null by default.

'use client';

import { AmbientDepth } from '@/components/custom/ambient-depth';
import { MotionKitProvider } from '@/components/custom/motion-kit/motion-kit-provider';
import { SolcoSupportChat } from '@/components/custom/solco-support-chat';

export function GlobalMounts() {
  return (
    <MotionKitProvider>
      <AmbientDepth />
      <SolcoSupportChat />
    </MotionKitProvider>
  );
}
