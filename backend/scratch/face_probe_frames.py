"""Mirror the ESP32-CAM framing and report what the backend answers for each
frame, including when the server itself is unreachable (Cloud Run cold start /
instance recycle while the device is polling).
"""
import io
import sys
import time
import requests
from PIL import Image, ImageDraw

BASE = "https://labsync-460952407297.asia-south1.run.app"
URL = f"{BASE}/api/face/enroll-hardware"


def frame(brightness=60, face_px=110, quality=12):
    img = Image.new("RGB", (320, 240), (brightness, brightness - 5, brightness - 10))
    d = ImageDraw.Draw(img)
    cx, cy = 160, 120
    r = face_px // 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(205, 172, 142))
    ed = int(r * 0.40)
    ew = max(3, int(r * 0.16))
    d.ellipse([cx - ed - ew, cy - int(r * 0.2), cx - ed + ew, cy + int(r * 0.05)], fill=(25, 25, 25))
    d.ellipse([cx + ed - ew, cy - int(r * 0.2), cx + ed + ew, cy + int(r * 0.05)], fill=(25, 25, 25))
    d.arc([cx - int(r * 0.35), cy + int(r * 0.25), cx + int(r * 0.35), cy + int(r * 0.6)], 0, 180, fill=(110, 55, 55), width=3)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def post(data, user_id, label):
    t0 = time.time()
    try:
        r = requests.post(
            URL,
            files={"faceImage": ("face.jpg", data, "image/jpeg")},
            data={"userId": user_id},
            timeout=45,
        )
        dt = (time.time() - t0) * 1000
        body = r.text
        short = body if len(body) < 230 else body[:230] + "..."
        print(f"{label:<28} HTTP {r.status_code} {dt:6.0f}ms  {short}")
        return r.status_code, body
    except Exception as exc:  # noqa: BLE001
        dt = (time.time() - t0) * 1000
        print(f"{label:<28} FAILED  {dt:6.0f}ms  {type(exc).__name__}: {exc}")
        return None, ""


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "spread"
    if mode == "spread":
        for px in (60, 80, 100, 120, 150):
            post(frame(face_px=px), f"TEST-PX-{px}", f"face {px}px")
    elif mode == "light":
        for b in (20, 40, 70, 110, 160):
            post(frame(brightness=b), f"TEST-LIGHT-{b}", f"brightness {b}")
    elif mode == "rapid":
        # ESP32 posts roughly every 0.7-1.2s during enrollment
        for i in range(6):
            post(frame(), "TEST-RAPID", f"rapid frame {i + 1}")
            time.sleep(0.8)
