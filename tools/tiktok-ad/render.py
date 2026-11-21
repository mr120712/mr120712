#!/usr/bin/env python3
# @polsia:user-owned — renders Solco's TikTok ad from the agents' storyboard (workers/ai-agents,
# target tiktok-ad) and a real 1080-px-wide screenshot of the home page (capture.mjs).
# Output: MP4 1080×1920, 30 fps, H.264 + a silent AAC track (pick the music in TikTok Ads Manager,
# from the Commercial Music Library: protected tracks are not allowed in ads).
# Usage: python3 tools/tiktok-ad/render.py storyboard.json home.png out.mp4 [logo.png]
import functools
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1080, 1920, 30
FADE = 0.25  # seconds of cross-fade between scenes
# TikTok safe area: keep text away from the top bar, the right-hand buttons and the bottom caption/CTA.
SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, SAFE_BOTTOM = 72, W - 150, 210, H - 430
BG = (11, 7, 18)
GRAD = [(139, 92, 246), (236, 72, 153), (245, 158, 11)]  # --grad-brand (dark theme)
MAGENTA = (255, 46, 136)
FONT_DIR = Path("/usr/share/fonts/opentype/inter")
BLACK = str(FONT_DIR / "InterDisplay-Black.otf")
SEMI = str(FONT_DIR / "Inter-SemiBold.otf")
BOLD = str(FONT_DIR / "Inter-Bold.otf")
# Regions of the 1080-px home screenshot (y from, y to): the hero above the live counter, and the
# Free plan card. Measured on the screenshot; override with HERO=a:b FREE=a:b if the page changes.
REGIONS = {"hero": (0, 1000), "free-plan": (2250, 3200)}


def ease(p):
    p = max(0.0, min(1.0, p))
    return p * p * (3 - 2 * p)


@functools.lru_cache(maxsize=64)
def gradient(size, colors=tuple(GRAD), angle=100):
    """Linear brand gradient (like CSS linear-gradient(100deg, …))."""
    w, h = size
    img = Image.new("RGB", (w, h))
    px = img.load()
    rad = math.radians(angle - 90)
    dx, dy = math.cos(rad), math.sin(rad)
    span = abs(w * dx) + abs(h * dy) or 1
    for y in range(h):
        for x in range(w):
            t = ((x * dx + y * dy) - min(0, w * dx) - min(0, h * dy)) / span
            t = max(0.0, min(1.0, t)) * (len(colors) - 1)
            i = min(int(t), len(colors) - 2)
            f = t - i
            a, b = colors[i], colors[i + 1]
            px[x, y] = tuple(int(a[k] + (b[k] - a[k]) * f) for k in range(3))
    return img


def background():
    """Near-black with soft brand glows (static: motion comes from the content)."""
    img = Image.new("RGB", (W, H), BG)
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse((-300, -200, 700, 800), fill=(70, 30, 130))
    d.ellipse((520, 1150, 1500, 2150), fill=(120, 20, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    return Image.blend(img, Image.composite(glow, img, Image.new("L", (W, H), 255)), 0.85)


def fit_font(text, path, max_w, start, min_size=40):
    size = start
    while size > min_size:
        font = ImageFont.truetype(path, size)
        lines = wrap(text, font, max_w)
        if len(lines) <= 3:
            return font, lines
        size -= 4
    font = ImageFont.truetype(path, min_size)
    return font, wrap(text, font, max_w)


def wrap(text, font, max_w):
    words, lines, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if font.getlength(trial) <= max_w or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


@functools.lru_cache(maxsize=256)
def text_block(text, path, size, max_w, fill="grad", align="left", line_gap=0.12):
    """Text as an RGBA image; fill = 'grad' (brand gradient), or an RGB tuple."""
    font, lines = fit_font(text, path, max_w, size)
    asc, desc = font.getmetrics()
    lh = int((asc + desc) * (1 + line_gap))
    w = int(max(font.getlength(l) for l in lines)) + 8
    h = lh * len(lines) + 8
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    for i, l in enumerate(lines):
        x = (w - font.getlength(l)) / 2 if align == "center" else 0
        d.text((x, i * lh), l, font=font, fill=255)
    color = gradient((w, h)).copy() if fill == "grad" else Image.new("RGB", (w, h), fill)
    out = color.convert("RGBA")
    out.putalpha(mask)
    return out


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def shadow(size, radius, blur=40, alpha=160):
    pad = blur * 2
    s = Image.new("RGBA", (size[0] + pad * 2, size[1] + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(s).rounded_rectangle((pad, pad, pad + size[0], pad + size[1]), radius, fill=(0, 0, 0, alpha))
    return s.filter(ImageFilter.GaussianBlur(blur)), pad


def paste_scaled(canvas, layer, cx, cy, scale=1.0, opacity=1.0):
    if scale != 1.0:
        layer = layer.resize((max(1, int(layer.width * scale)), max(1, int(layer.height * scale))), Image.LANCZOS)
    if opacity < 1.0:
        a = layer.getchannel("A").point(lambda v: int(v * opacity))
        layer = layer.copy()
        layer.putalpha(a)
    canvas.alpha_composite(layer, (int(cx - layer.width / 2), int(cy - layer.height / 2)))


class Renderer:
    def __init__(self, board, home, logo):
        self.board = board
        self.bg = background().convert("RGBA")
        self.home = home
        self.logo = logo
        self.cache = {}

    def card(self, screen):
        """The real screenshot region in a rounded card, wider than the window for panning."""
        if screen in self.cache:
            return self.cache[screen]
        y0, y1 = REGIONS[screen]
        region = self.home.crop((0, y0, self.home.width, min(y1, self.home.height)))
        width = 820
        scaled = region.resize((width, int(region.height * width / region.width)), Image.LANCZOS)
        self.cache[screen] = scaled
        return scaled

    def headline(self, scene, p, top=SAFE_TOP + 40, big=False):
        """Headline (+ subline) sliding up and fading in during the first 0.35 of the scene."""
        frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        k = ease(p / 0.35)
        max_w = SAFE_RIGHT - SAFE_LEFT
        if scene["headline"]:
            head = text_block(scene["headline"], BLACK, 132 if big else 104, max_w, "grad", "center" if big else "left")
            x = (W - head.width) // 2 if big else SAFE_LEFT
            y = (H - head.height) // 2 - 120 if big else top
            head = head.copy()
            head.putalpha(head.getchannel("A").point(lambda v: int(v * k)))
            frame.alpha_composite(head, (x, int(y + (1 - k) * 40)))
            y_after = int(y + head.height + 24)
        else:
            y_after = top
        if scene.get("subline"):
            sub = text_block(scene["subline"], SEMI, 52, max_w, (240, 236, 245), "center" if big else "left")
            x = (W - sub.width) // 2 if big else SAFE_LEFT
            sub = sub.copy()
            sub.putalpha(sub.getchannel("A").point(lambda v: int(v * ease((p - 0.12) / 0.35))))
            frame.alpha_composite(sub, (x, y_after))
        return frame

    def text_height(self, scene):
        """Height of the headline + subline block at the top (so the card starts below it)."""
        max_w = SAFE_RIGHT - SAFE_LEFT
        h = 0
        if scene["headline"]:
            h += text_block(scene["headline"], BLACK, 104, max_w, "grad", "left").height + 24
        if scene.get("subline"):
            h += text_block(scene["subline"], SEMI, 52, max_w, (240, 236, 245), "left").height
        return h

    def scene_frame(self, scene, t):
        length = scene["end"] - scene["start"]
        p = (t - scene["start"]) / length
        frame = self.bg.copy()
        screen, motion = scene["screen"], scene["motion"]
        if screen in REGIONS:
            card = self.card(screen)
            top = SAFE_TOP + 10 + self.text_height(scene) + 56
            win_h = min(card.height, SAFE_BOTTOM + 260 - top)
            travel = max(0, card.height - win_h)
            if motion == "pan-down":
                off = travel * ease(p)
            elif motion == "pan-up":
                off = travel * (1 - ease(p))
            else:
                off = 0
            window = rounded(card.crop((0, int(off), card.width, int(off) + win_h)), 44)
            scale = {"zoom-in": 0.96 + 0.06 * ease(p), "zoom-out": 1.04 - 0.06 * ease(p)}.get(motion, 1.0)
            cy = top + win_h / 2
            sh, pad = shadow(window.size, 44)
            paste_scaled(frame, sh, W / 2, cy + 18, scale, 0.9)
            paste_scaled(frame, window, W / 2, cy, scale)
            frame.alpha_composite(self.headline(scene, p, top=SAFE_TOP + 10))
        elif screen == "logo":
            s = 0.9 + 0.12 * ease(p) if motion != "static" else 1.0
            icon = self.logo.resize((340, 340), Image.LANCZOS)
            paste_scaled(frame, icon, W / 2, 720, s, ease(p / 0.3))
            word = text_block("Solco", BLACK, 150, 900, (255, 255, 255), "center")
            paste_scaled(frame, word, W / 2, 1010, s, ease((p - 0.1) / 0.3))
            if scene["headline"]:
                tag = text_block(scene["headline"], SEMI, 58, 860, "grad", "center")
                paste_scaled(frame, tag, W / 2, 1180, 1.0, ease((p - 0.25) / 0.35))
        elif screen == "text":
            pop = 0.86 + 0.14 * ease(p / 0.3)
            layer = self.headline(scene, min(1.0, p * 1.4), big=True)
            paste_scaled(frame, layer, W / 2, H / 2, pop)
        else:  # end-card
            icon = self.logo.resize((240, 240), Image.LANCZOS)
            paste_scaled(frame, icon, W / 2, 560, 1.0, ease(p / 0.25))
            if scene["headline"]:
                head = text_block(scene["headline"], BLACK, 100, SAFE_RIGHT - SAFE_LEFT, "grad", "center")
                paste_scaled(frame, head, W / 2, 860, 1.0, ease((p - 0.05) / 0.3))
            cta = self.board.get("cta") or "Inizia gratis"
            label = text_block(cta, BOLD, 58, 700, (255, 255, 255), "center")
            pill_w, pill_h = label.width + 120, label.height + 64
            pill = rounded(gradient((pill_w, pill_h)).copy(), pill_h // 2)
            pill.alpha_composite(label, ((pill_w - label.width) // 2, (pill_h - label.height) // 2 + 4))
            pulse = 1.0 + 0.03 * math.sin(p * math.pi * 4) * ease((p - 0.3) / 0.2)
            paste_scaled(frame, pill, W / 2, 1110, pulse, ease((p - 0.15) / 0.3))
            url = text_block(scene.get("subline") or "solcomusic.online", SEMI, 54, 860, (235, 230, 245), "center")
            paste_scaled(frame, url, W / 2, 1280, 1.0, ease((p - 0.3) / 0.3))
        return frame

    def frame(self, t):
        scenes = self.board["scenes"]
        current = next((s for s in scenes if s["start"] <= t < s["end"]), scenes[-1])
        img = self.scene_frame(current, t)
        idx = scenes.index(current)
        if idx > 0 and t - current["start"] < FADE:  # cross-fade from the previous scene
            prev = scenes[idx - 1]
            img = Image.blend(self.scene_frame(prev, min(t, prev["end"] - 1e-3)), img, (t - current["start"]) / FADE)
        return img.convert("RGB")


def main():
    board_path, home_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    logo_path = sys.argv[4] if len(sys.argv) > 4 else "public/solco-icon-512.png"
    board = json.loads(Path(board_path).read_text())
    home = Image.open(home_path).convert("RGB")
    if home.width != 1080:
        home = home.resize((1080, int(home.height * 1080 / home.width)), Image.LANCZOS)
    logo = rounded(Image.open(logo_path).convert("RGBA"), 110)
    r = Renderer(board, home, logo)
    total = board["durationSeconds"]
    frames = int(round(total * FPS))
    ff = subprocess.Popen(
        [
            "ffmpeg", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
            "-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
            "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out,
        ],
        stdin=subprocess.PIPE,
    )
    for i in range(frames):
        ff.stdin.write(r.frame(i / FPS).tobytes())
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"{out}: {frames} frames, {total:.1f} s")


if __name__ == "__main__":
    main()
