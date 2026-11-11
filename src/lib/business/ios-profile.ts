// @polsia:user-owned — profilo di configurazione iOS (Web Clip): aggiunge Solco alla schermata
// Home a schermo intero, senza App Store. Non installa codice: apre il sito come un'app.
import { IOS_PROFILE_ICON_BASE64 } from '@/lib/business/ios-profile-icon';

const PROFILE_UUID = '027a41a3-2409-410e-90fa-b9d38dd0d75d';
const WEBCLIP_UUID = 'c49dea84-1117-485a-b55d-86ce432ae082';

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildIosProfile(appUrl: string) {
  const url = escapeXml(`${appUrl.replace(/\/+$/, '')}/`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>app.solcomusic.solco.webclip</string>
      <key>PayloadUUID</key>
      <string>${WEBCLIP_UUID}</string>
      <key>PayloadDisplayName</key>
      <string>Solco</string>
      <key>Label</key>
      <string>Solco</string>
      <key>URL</key>
      <string>${url}</string>
      <key>Icon</key>
      <data>${IOS_PROFILE_ICON_BASE64}</data>
      <key>Precomposed</key>
      <true/>
      <key>FullScreen</key>
      <true/>
      <key>IsRemovable</key>
      <true/>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>app.solcomusic.solco.profile</string>
  <key>PayloadUUID</key>
  <string>${PROFILE_UUID}</string>
  <key>PayloadDisplayName</key>
  <string>Solco</string>
  <key>PayloadDescription</key>
  <string>Aggiunge Solco alla schermata Home: si apre a schermo intero come un'app. Non installa software e puoi rimuoverlo quando vuoi da Impostazioni › Generali › VPN e gestione dispositivi.</string>
  <key>PayloadOrganization</key>
  <string>Solco</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>
`;
}
