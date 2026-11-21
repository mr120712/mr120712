# Solco TikTok ad

A 9:16 ad for TikTok, made in three steps:

1. **The agents write it.** On GitHub, run **Actions → "AI agents: performance review"** with
   target **`tiktok-ad`**. Six agents each cover one part:
   - strategy;
   - hook and copy;
   - direction;
   - sound;
   - TikTok Ads specs;
   - compliance.

   They work only from Solco's real facts (brand, sections, the home page's visible text, plans
   and limits included). A lead agent returns a validated storyboard (`storyboard.json` in the
   run's artifact, also printed in the log).
2. **Capture the real screens.**
   `node tools/tiktok-ad/capture.mjs <dir>` saves the home page at 1080 px wide, as a visitor
   without an account sees it.
   - It passes Solco's anti-bot gate with the same proof-of-work as the loading screen.
   - Set `CHROMIUM_PATH` to use a browser already installed.
   - Don't run it in a loop: Vercel's firewall blocks a browser that opens many pages quickly.
3. **Render.**
   `python3 tools/tiktok-ad/render.py storyboard.json <dir>/home.png out.mp4` produces an MP4
   1080×1920, 30 fps, H.264, with a silent audio track.
   - Text stays inside TikTok's safe area: away from the top, the right-hand buttons and the
     bottom caption/CTA.

`out/` holds the current ad: `solco-tiktok-ad.mp4`, its `storyboard.json` and `preview.png`.

## Before publishing

- **Music.** Add it in TikTok Ads Manager from the **Commercial Music Library**. Protected tracks
  are not allowed in ads. The storyboard's `music` field has the mood, BPM and search words.
- **Claims.** The Free plan has 40 plays a month (radio and YouTube unlimited): the ad says so.
  Don't add "unlimited free music", prices or Solco Pro.
- **Ad text.** The ad text in Ads Manager is limited to 100 characters.
