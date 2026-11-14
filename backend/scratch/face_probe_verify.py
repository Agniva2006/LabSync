"""Verify a live enrolled user against the deployed backend.

Uses the same synthetic face that enrolled successfully, twice: once as the
"same person" (should match) and once as a different person (should not).
This tells us whether the enrollment template is usable for verification.
"""
import io
import sys
import requests
from PIL import Image, ImageDraw

BASE = "https://labsync-460952407297.asia-south1.run.app"


def face(seed=0, quality=12, bg=60):
    img = Image.new("RGB", (320, 240), (bg, bg - 5, bg - 10))
    d = ImageDraw.Draw(img)
    cx, cy = 160 + seed * 4, 120 + seed * 3
    r = 55
    skin = (205 - seed * 20, 172 - seed * 12, 142 - seed * 8)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=skin)
    ed = int(r * 0.40)
    ew = max(4, int(r * 0.16))
    eye_y = cy - int(r * 0.2)
    d.ellipse([cx - ed - ew, eye_y, cx - ed + ew, eye_y + int(ew * 1.4)], fill=(25, 25, 25))
    d.ellipse([cx + ed - ew, eye_y, cx + ed + ew, eye_y + int(ew * 1.4)], fill=(25, 25, 25))
    d.arc([cx - int(r * 0.35), cy + int(r * 0.25), cx + int(r * 0.35), cy + int(r * 0.6)],
          0, 180, fill=(110, 55, 55), width=3)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def enroll(uid, data):
    r = requests.post(
        f"{BASE}/api/face/enroll-hardware",
        files={"faceImage": ("face.jpg", data, "image/jpeg")},
        data={"userId": uid},
        timeout=90,
    )
    print(f"ENROLL {uid}: {r.status_code} {r.text[:260]}")
    return r


def verify(uid, data, label):
    r = requests.post(
        f"{BASE}/api/face/verify",
        files={"faceImage": ("face.jpg", data, "image/jpeg")},
        data={"userId": uid, "roomId": "ROOM-001"},
        timeout=90,
    )
    print(f"VERIFY {label:<16}: {r.status_code} {r.text[:300]}")


if __name__ == "__main__":
    uid = "TEST-VERIFY-001"
    same = face(seed=0)
    other = face(seed=6)
    enroll(uid, same)
    verify(uid, same, "same person")
    verify(uid, other, "different person")
    verify(uid, same, "same person #2")
