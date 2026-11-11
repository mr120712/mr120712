// @polsia:user-owned — scarica il profilo iOS di Solco (Web Clip a schermo intero).
import { buildIosProfile } from '@/lib/business/ios-profile';
import { siteUrl } from '@/lib/site';

export const dynamic = 'force-static';

export function GET() {
  return new Response(buildIosProfile(siteUrl), {
    headers: {
      // iOS opens the profile installer only for this content type.
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': 'attachment; filename="solco.mobileconfig"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
