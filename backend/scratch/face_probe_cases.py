"""Probe deployed face endpoints with frames that mimic real ESP32-CAM output.

Cases:
  blur      heavily out-of-focus frame (soft lens / subject moving)
  edge      face pushed to the edge of frame (reticle cropping)
  tiny      face small in frame (user too far away)
  yaw       face turned to the side (only one eye clearly visible)
  double    two faces present
  session   several frames posted rapidly in one enrollment session
"""
import io
import sys
import requests
from PIL import Image, ImageDraw, ImageFilter

BASE = "https://labsync-460952407297.asia-south1.run.app"
URL = f"{BASE}/api/face/enroll-hardware"


def face_at(cx, cy, r, yaw=0, base=(170, 160, 150), skin=(205, 170, 140)):
    img = Image.new("RGB", (320, 240), base)
    d = ImageDraw.Draw(img)
    # slightly rotated/asymmetric head for yaw
    l = cx - r
    rr = cx + r
    d.ellipse([l, cy - r, rr, cy + r * 1.1], fill=skin)
    eye_dx = int(r * 0.42)
    eye_y = cy - int(r * 0.15)
    eye_w = int(r * 0.26)
    if yaw == 0:
        d.ellipse([cx - eye_dx - eye_w, eye_y, cx - eye_dx + eye_w, eye_y + eye_w * 1.3], fill=(30, 30, 30))
        d.ellipse([cx + eye_dx - eye_w, eye_y, cx + eye_dx + eye_w, eye_y + eye_w * 1.3], fill=(30, 30, 30))
    else:
        # only the far eye clearly visible
        d.ellipse([cx + eye_dx - eye_w, eye_y, cx + eye_dx + eye_w, eye_y + eye_w * 1.3], fill=(30, 30, 30))
    d.polygon([(cx, cy - r * 0.1), (cx - r * 0.12, cy + r * 0.3), (cx + r * 0.12, cy + r * 0.3)], fill=(185, 150, 125))
    d.arc([cx - r * 0.35, cy + r * 0.35, cx + r * 0.35, cy + r * 0.65], 0, 180, fill=(120, 60, 60), width=4)
    return img


def encode(img, quality=12):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def build(case):
    if case == "blur":
        return encode(face_at(160, 115, 55).filter(ImageFilter.GaussianBlur(2.6)))
    if case == "edge":
        return encode(face_at(280, 110, 50))
    if case == "tiny":
        return encode(face_at(160, 110, 22))
    if case == "yaw":
        return encode(face_at(160, 115, 55, yaw=1))
    if case == "double":
        img = face_at(90, 115, 45)
        second = face_at(240, 115, 45)
        img.paste(second, (0, 0), second.convert("RGBA"))
        return encode(img)
    raise SystemExit(f"unknown case {case}")


def post(data, user_id):
    r = requests.post(
        URL,
        files={"faceImage": ("face.jpg", data, "image/jpeg")},
        data={"userId": user_id},
        timeout=90,
    )
    return r.status_code, r.text


if __name__ == "__main__":
    case = sys.argv[1]
    if case == "session":
        for i in range(5):
            code, body = post(build("blur"), "TEST-FACE-SESSION")
            print(f"frame {i + 1}: {code} {body[:220]}")
        sys.exit(0)

    code, body = post(build(case), f"TEST-FACE-{case.upper()}")
    print(f"{case}: {code} {body[:400]}")
