"""Probe the deployed /api/face/enroll-hardware endpoint with synthetic frames.

Prints the exact server verdict so we can tell a detection problem apart from
a session/timeout problem.
"""
import io
import sys
import requests
from PIL import Image, ImageDraw, ImageFilter

BASE = "https://labsync-460952407297.asia-south1.run.app"


def make_frame(dark=False, quality=12):
    """A crude 'face-like' image at ESP32-CAM QVGA resolution."""
    img = Image.new("RGB", (320, 240), (30, 30, 32) if dark else (170, 160, 150))
    d = ImageDraw.Draw(img)
    # Head
    d.ellipse([110, 50, 210, 190], fill=(205, 170, 140))
    # Eyes
    d.ellipse([128, 95, 146, 110], fill=(30, 30, 30))
    d.ellipse([174, 95, 192, 110], fill=(30, 30, 30))
    # Nose
    d.polygon([(160, 112), (152, 138), (168, 138)], fill=(185, 150, 125))
    # Mouth
    d.arc([140, 145, 180, 170], 0, 180, fill=(120, 60, 60), width=4)
    img = img.filter(ImageFilter.GaussianBlur(0.7))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def send(label, data, user_id="TEST-FACE-001"):
    r = requests.post(
        f"{BASE}/api/face/enroll-hardware",
        files={"faceImage": ("face.jpg", data, "image/jpeg")},
        data={"userId": user_id},
        timeout=90,
    )
    print(f"--- {label} ({len(data)} bytes) -> HTTP {r.status_code}")
    print(r.text[:600])
    print()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
    if mode == "normal":
        send("normal frame", make_frame())
    elif mode == "dark":
        send("dark frame", make_frame(dark=True), "TEST-FACE-002")
    elif mode == "repeat":
        # Emulate the ESP32 posting several frames in one enrollment session
        for i in range(4):
            send(f"session frame {i + 1}", make_frame(), "TEST-FACE-003")
